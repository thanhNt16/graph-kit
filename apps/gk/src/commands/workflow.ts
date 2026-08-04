import { GraphKitError } from "../errors.js";
import type { DispatchContract, WorkflowContract } from "../runtime/contracts.js";
import type { Scope } from "../runtime/expression.js";
import { issueLeases, settleLease, validateLease } from "../runtime/leases.js";
import { mergeStateField } from "../runtime/merges.js";
import { selectTransition } from "../runtime/state-machine.js";
import {
  appendRunEvent,
  createRun,
  type MutationResult,
  mutateRun,
  type RunDocuments,
  readRun,
} from "../runtime/store.js";
import { validateOutput } from "../runtime/validation.js";
import type { Run, Verdict, Workflow } from "../schemas.js";
import type { LoadedTemplate } from "../templates/loader.js";

export interface SubmitSpec {
  lease?: string;
  work_item?: string;
  node?: string;
  verdict?: Verdict;
  actor?: string;
}

export interface SubmitResult {
  documents: RunDocuments;
  state: Record<string, unknown>;
  run: Run;
}

const SUBMIT_CMD = ["gk", "workflow", "submit"];
const INPUTS_KEY = "__inputs";
const FAN_ITEMS_PREFIX = "__fan_items__";

function nodeFor(workflow: Workflow, id: string): Workflow["nodes"][string] {
  const node = workflow.nodes[id];
  if (!node) throw new GraphKitError("INVALID_TRANSITION", `unknown node '${id}'`);
  return node;
}

/** Runtime scope for the expression engine. */
function scopeFor(workflow: Workflow, run: Run, state: Record<string, unknown>): Scope {
  return {
    inputs: (state[INPUTS_KEY] as Record<string, unknown>) ?? {},
    state,
    run,
    limits: workflow.limits ?? {},
  };
}

function workItem(item: unknown): string {
  if (item !== null && typeof item === "object" && "name" in item) return String((item as { name: unknown }).name);
  return String(item);
}

/** The single agent worker node a fanout dispatches work to. */
function fanoutTarget(workflow: Workflow, fanId: string): string {
  const fan = nodeFor(workflow, fanId);
  if (fan.type !== "fanout") throw new GraphKitError("INVALID_TRANSITION", `'${fanId}' is not a fanout`);
  // Find the agent whose save_as field holds the fanout's work items — that's the
  // worker that reports results for each item. No declarative edge, so scan.
  const agents = Object.values(workflow.nodes).filter(
    (n): n is Workflow["nodes"][string] & { type: "agent" } => n.type === "agent",
  );
  for (const agent of agents) {
    if (agent.output.save_as === fan.from) return agent.id;
  }
  // Fallback: first agent node
  if (agents.length) return agents[0].id;
  throw new GraphKitError("INVALID_TRANSITION", `fanout '${fanId}' has no agent worker node`);
}

/** The join node that collects a fanout's field, if any. */
function joinFor(workflow: Workflow, fanId: string): string {
  const fan = nodeFor(workflow, fanId);
  if (fan.type !== "fanout") throw new GraphKitError("INVALID_TRANSITION", `'${fanId}' is not a fanout`);
  for (const [id, node] of Object.entries(workflow.nodes)) {
    if (node.type === "join" && node.merge === fan.from) return id;
  }
  throw new GraphKitError("INVALID_TRANSITION", `fanout '${fanId}' has no join for '${fan.from}'`);
}

/** The fanout (if any) whose worker is the given agent node. */
function fanParent(workflow: Workflow, nodeId: string): string | undefined {
  for (const [id, node] of Object.entries(workflow.nodes)) {
    if (node.type === "fanout" && fanoutTarget(workflow, id) === nodeId) return id;
  }
  return undefined;
}

/** Whether every required fanout item has a settled lease. */
function fanIsComplete(workflow: Workflow, fanId: string, d: RunDocuments): boolean {
  const fan = nodeFor(workflow, fanId);
  if (fan.type !== "fanout") return true;
  const items = (d.state[`${FAN_ITEMS_PREFIX}${fan.from}`] as unknown[] | undefined) ?? [];
  const settled = new Set(d.leases.filter((l) => l.status === "settled").map((l) => l.work_item));
  return items.every((item) => settled.has(workItem(item)));
}

/** Expired workers become failed evidence and are eligible for re-dispatch. */
function recoverExpiredLeases(d: RunDocuments, now: number): void {
  for (const lease of d.leases) {
    if (lease.status === "active" && Date.parse(lease.expires_at) <= now) {
      lease.status = "expired";
      if (d.run.in_flight[lease.work_item] === lease.id) delete d.run.in_flight[lease.work_item];
    }
  }
}

function emptyDispatch(loaded: LoadedTemplate, fanId: string): DispatchContract {
  const workflow = loaded.workflow;
  const fan = nodeFor(workflow, fanId);
  if (fan.type !== "fanout") throw new GraphKitError("INVALID_TRANSITION", `'${fanId}' is not a fanout`);
  const target = fanoutTarget(workflow, fanId);
  const worker = nodeFor(workflow, target);
  if (worker.type !== "agent") throw new GraphKitError("INVALID_TRANSITION", "fanout worker is not an agent");
  return {
    kind: "dispatch",
    worker_skill: worker.skill,
    items: [],
    concurrency_ceiling: Math.min(fan.max_workers, workflow.limits?.max_workers ?? fan.max_workers),
    join_merge_policy: workflow.state?.[fan.from]?.merge ?? "append",
  };
}

/** Build a dispatch contract, issuing one fresh lease per available slot. Pure. */
function dispatchContract(
  loaded: LoadedTemplate,
  run: Run,
  leases: { work_item: string; status: string }[],
  state: Record<string, unknown>,
  fanId: string,
): DispatchContract {
  const workflow = loaded.workflow;
  const fan = nodeFor(workflow, fanId);
  if (fan.type !== "fanout") throw new GraphKitError("INVALID_TRANSITION", `'${fanId}' is not a fanout`);
  const target = fanoutTarget(workflow, fanId);
  const targetNode = nodeFor(workflow, target);
  if (targetNode.type !== "agent")
    throw new GraphKitError("INVALID_TRANSITION", `fanout target '${target}' is not an agent`);
  const items = (state[fan.from] as unknown[] | undefined) ?? [];
  const originalItems = (state[`${FAN_ITEMS_PREFIX}${fan.from}`] as unknown[] | undefined) ?? items;
  const settled = new Set(leases.filter((l) => l.status === "settled").map((l) => l.work_item));
  const inFlight = new Set(Object.keys(run.in_flight ?? {}));
  const ready = originalItems.filter((item) => !settled.has(workItem(item)) && !inFlight.has(workItem(item)));
  const freeSlots = Math.max(0, fan.max_workers - inFlight.size);
  const ceiling = Math.min(
    fan.max_workers,
    workflow.limits?.max_workers ?? Number.POSITIVE_INFINITY,
    freeSlots,
    ready.length,
  );
  const batch = ready.slice(0, ceiling);
  const issued = issueLeases(batch.map((item) => ({ work_item: workItem(item), node: target, now: Date.now() })));
  return {
    kind: "dispatch",
    worker_skill: targetNode.skill,
    items: batch.map((item, i) => ({ work_item: workItem(item), lease: issued[i], node: target })),
    concurrency_ceiling: ceiling,
    join_merge_policy: workflow.state?.[fan.from]?.merge ?? "append",
  };
}

export async function startWorkflow(
  project: string,
  loaded: LoadedTemplate,
  inputs: Record<string, unknown>,
  runId: string,
): Promise<Run> {
  const workflow = loaded.workflow;
  const run: Run = {
    run_id: runId,
    template: loaded.manifest.name,
    harness: loaded.manifest.harness,
    status: "running",
    current_nodes: [workflow.start],
    pending_items: [],
    in_flight: {},
    iteration: 0,
    failures: 0,
    completed_deterministic_nodes: [],
    verdict: null,
  };
  await createRun(project, run, { ...inputs, [INPUTS_KEY]: inputs }, []);
  // Snapshot each fanout's source items so the fan-in pending set is stable even
  // though the merged field accumulates decorated results.
  await mutateRun(project, runId, (d) => {
    for (const node of Object.values(workflow.nodes)) {
      if (node.type === "fanout") d.state[`${FAN_ITEMS_PREFIX}${node.from}`] = d.state[node.from] ?? [];
    }
    return d;
  });
  // Advance past the virtual start sentinel so the first node is concrete.
  await mutateRun(project, runId, (d) => {
    const decision = selectTransition({
      workflow,
      run: d.run,
      scope: scopeFor(workflow, d.run, d.state),
      completed: workflow.start,
    });
    if ("terminal" in decision) {
      d.run.verdict = decision.verdict;
      d.run.status = "done";
      d.run.current_nodes = [];
      return d;
    }
    d.run.current_nodes = decision.next;
    return d;
  });
  return run;
}

/** Produce the next contract for a run. Side-effect-free except dispatch lease writeback and required transitions. */
export async function nextWorkflow(project: string, loaded: LoadedTemplate, runId: string): Promise<WorkflowContract> {
  const workflow = loaded.workflow;
  const docs = await readRun(project, runId);
  const { run, state } = docs;
  const scope = scopeFor(workflow, run, state);

  if (run.status === "done") return { kind: "terminal", verdict: run.verdict ?? "failed" };
  if (run.status === "paused") {
    const node = nodeFor(workflow, run.current_nodes[0]);
    if (node.type !== "human") throw new GraphKitError("INVALID_TRANSITION", "paused run is not on a human node");
    return { kind: "paused", node: node.id, prompt: node.prompt, actions: node.actions };
  }

  const current = run.current_nodes[0];
  const node = nodeFor(workflow, current);
  switch (node.type) {
    case "agent":
      return {
        kind: "agent",
        node: node.id,
        objective: node.objective,
        context: { inputs: scope.inputs, state: stripInputs(state) },
        tool_allowlist: node.tools,
        skill: node.skill,
        limits: workflow.limits ?? {},
        required_evidence: [],
        output_schema: loaded.outputSchemas.get(node.id) ?? "",
        output_save_as: node.output.save_as,
        submit_argv: [...SUBMIT_CMD, runId, node.id],
      };
    case "fanout": {
      let issuedContract: DispatchContract | undefined;
      const result = await mutateRun(project, runId, (d) => {
        recoverExpiredLeases(d, Date.now());
        const contract = dispatchContract(loaded, d.run, d.leases, d.state, current);
        issuedContract = contract;
        if (contract.items.length) {
          for (const item of contract.items) {
            d.run.in_flight[item.work_item] = item.lease.id;
            d.leases.push(item.lease);
            d.run.current_nodes = [item.node];
          }
        } else if (!fanIsComplete(workflow, current, d)) {
          d.run.current_nodes = [current];
        } else {
          d.run.current_nodes = [joinFor(workflow, current)];
        }
        return {
          documents: d,
          event: {
            type: "dispatch",
            node: current,
            details: { items: contract.items.map((i) => i.work_item) },
            timestamp: new Date().toISOString(),
          },
        };
      });
      if (issuedContract?.items.length) return issuedContract;
      if (!fanIsComplete(workflow, current, result.documents)) return emptyDispatch(loaded, current);
      return nextWorkflow(project, loaded, runId);
    }
    case "command":
      return { kind: "deterministic", node: node.id, argv: node.command };
    case "graph":
      return { kind: "deterministic", node: node.id, argv: [node.operation] };
    case "validator":
      return { kind: "deterministic", node: node.id, argv: node.checks };
    case "human": {
      await mutateRun(project, runId, (d) => {
        d.run.status = "paused";
        return {
          documents: d,
          event: { type: "human", node: node.id, timestamp: new Date().toISOString() },
        };
      });
      return { kind: "paused", node: node.id, prompt: node.prompt, actions: node.actions };
    }
    case "join":
    case "router": {
      const decision = selectTransition({ workflow, run, scope, completed: current });
      if ("terminal" in decision) return { kind: "terminal", verdict: decision.verdict };
      return deterministicOrAgent(loaded, run, decision.next[0], state);
    }
    default:
      throw new GraphKitError("INVALID_TRANSITION", `no contract for node '${current}'`);
  }
}

function stripInputs(state: Record<string, unknown>): Record<string, unknown> {
  const { [INPUTS_KEY]: _inputs, ...rest } = state;
  void _inputs;
  return rest;
}

/** Wrap a following node as a contract; falls back to an empty deterministic shell. */
function deterministicOrAgent(
  loaded: LoadedTemplate,
  run: Run,
  next: string,
  state: Record<string, unknown>,
): WorkflowContract {
  const workflow = loaded.workflow;
  const node = nodeFor(workflow, next);
  if (node.type === "agent")
    return {
      kind: "agent",
      node: next,
      objective: node.objective,
      context: { inputs: (state["__inputs"] as Record<string, unknown>) ?? {}, state: stripInputs(state) },
      tool_allowlist: node.tools,
      skill: node.skill,
      limits: workflow.limits ?? {},
      required_evidence: [],
      output_schema: loaded.outputSchemas.get(next) ?? "",
      output_save_as: node.output.save_as,
      submit_argv: [...SUBMIT_CMD, run.run_id, next],
    };
  if (node.type === "graph") return { kind: "deterministic", node: next, argv: [node.operation] };
  if (node.type === "command") return { kind: "deterministic", node: next, argv: node.command };
  if (node.type === "validator") return { kind: "deterministic", node: next, argv: node.checks };
  return { kind: "deterministic", node: next, argv: [] };
}

export async function submitWorkflow(
  project: string,
  loaded: LoadedTemplate,
  runId: string,
  output: unknown,
  spec: SubmitSpec = {},
): Promise<SubmitResult> {
  const workflow = loaded.workflow;
  const before = await readRun(project, runId);
  const node = before.run.current_nodes[0];
  if (before.run.status === "done" || !node || !workflow.nodes[node]) {
    const err = new GraphKitError("INVALID_TRANSITION", "run is no longer accepting submissions");
    await reject(project, runId, err.code, node ?? "start", spec, err);
    throw err;
  }
  const nodeDef = nodeFor(workflow, node);

  // Validate output against the schema BEFORE taking the mutation lock.
  let saveAs: string | undefined;
  if (nodeDef.type === "agent") {
    const schema = loaded.outputSchemas.get(node);
    if (!schema) throw new GraphKitError("SCHEMA_VIOLATION", "no output schema for agent node");
    try {
      validateOutput(schema, output);
    } catch (err) {
      await reject(project, runId, "SCHEMA_VIOLATION", node, spec, err);
      throw err;
    }
    saveAs = nodeDef.output.save_as;
  }
  if (nodeDef.type === "human" && typeof output !== "string") {
    const err = new GraphKitError("SCHEMA_VIOLATION", "human submission must be an action string");
    await reject(project, runId, "SCHEMA_VIOLATION", node, spec, err);
    throw err;
  }

  let result: MutationResult;
  try {
    result = await mutateRun(project, runId, (d) => {
      const current = d.run.current_nodes[0];
      let cur =
        current === workflow.start && spec.lease
          ? nodeFor(workflow, d.leases.find((l) => l.id === spec.lease)?.node ?? current)
          : nodeFor(workflow, current);
      if (cur.type === "fanout" && spec.lease) cur = nodeFor(workflow, fanoutTarget(workflow, cur.id));

      if (spec.lease) {
        validateLease({ leases: d.leases, now: Date.now(), id: spec.lease, work_item: spec.work_item ?? "" });
        settleLease({ leases: d.leases, now: Date.now(), id: spec.lease });
        if (spec.work_item) delete d.run.in_flight[spec.work_item];
      }

      if (cur.type === "human") {
        return {
          documents: finishHuman(workflow, d, cur.id, spec),
          event: {
            type: "submit",
            node: cur.id,
            lease: spec.lease,
            actor: spec.actor ?? "human",
            timestamp: new Date().toISOString(),
          },
        };
      }
      if (cur.type !== "agent")
        throw new GraphKitError("INVALID_TRANSITION", `cannot submit output to node '${current}'`);

      const verdict = spec.verdict ?? "passed";
      const parent = fanParent(workflow, cur.id);
      if (parent) {
        const fan = nodeFor(workflow, parent);
        if (fan.type !== "fanout") throw new GraphKitError("INVALID_TRANSITION", `'${parent}' is not a fanout`);
        const declaration = workflow.state ? workflow.state[fan.from] : undefined;
        const value = {
          ...(output as Record<string, unknown>),
          name: `${spec.work_item ?? workItem(output)}:${verdict}`,
        };
        if (declaration) d.state[fan.from] = mergeStateField(declaration, d.state[fan.from], [value]);
        const docs = advance(workflow, d, cur.id, "passed", spec);
        return {
          documents: docs,
          event: {
            type: "submit",
            node: cur.id,
            lease: spec.lease,
            actor: spec.actor ?? "worker",
            timestamp: new Date().toISOString(),
          },
        };
      }
      const declaration = workflow.state ? workflow.state[saveAs as string] : undefined;
      if (declaration) d.state[saveAs as string] = mergeStateField(declaration, d.state[saveAs as string], output);
      const docs = advance(workflow, d, cur.id, "passed", spec);
      return {
        documents: docs,
        event: {
          type: "submit",
          node: cur.id,
          lease: spec.lease,
          actor: spec.actor ?? "worker",
          timestamp: new Date().toISOString(),
        },
      };
    });
  } catch (err) {
    if (err instanceof GraphKitError && (err.code === "LEASE_INVALID" || err.code === "LEASE_EXPIRED")) {
      await reject(project, runId, err.code, node, spec, err);
    }
    throw err;
  }

  return { documents: result.documents, state: result.documents.state, run: result.documents.run };
}

async function reject(
  project: string,
  runId: string,
  code: string,
  node: string,
  spec: SubmitSpec,
  cause: unknown,
): Promise<void> {
  await appendRunEvent(project, runId, {
    type: "reject",
    run_id: runId,
    node,
    lease: spec.lease,
    actor: spec.actor,
    timestamp: new Date().toISOString(),
    details: { code, message: cause instanceof Error ? cause.message : String(cause), work_item: spec.work_item },
  });
}

function finishHuman(workflow: Workflow, d: RunDocuments, nodeId: string, spec: SubmitSpec): RunDocuments {
  const denied = spec.verdict === "failed" || spec.verdict === "cancelled";
  if (denied) {
    d.run.verdict = "failed";
    d.run.status = "done";
    d.run.current_nodes = [];
    return d;
  }
  d.run.status = "running";
  return advance(workflow, d, nodeId, "passed", spec);
}

/** Apply a completed node: ask the state machine for the next edge, honor the iteration cap. */
function advance(
  workflow: Workflow,
  d: RunDocuments,
  completed: string,
  verdict: Verdict,
  spec: SubmitSpec,
): RunDocuments {
  const fallback = spec.verdict ?? verdict;

  // A fanout-target agent loops back to its fanout; the fanout reissues slots or
  // opens the join once its items are fully settled.
  const parent = fanParent(workflow, completed);
  if (parent) {
    d.run.current_nodes = fanIsComplete(workflow, parent, d) ? [joinFor(workflow, parent)] : [parent];
    return d;
  }

  const decision = selectTransition({
    workflow,
    run: d.run,
    scope: scopeFor(workflow, d.run, d.state),
    completed,
    failed: fallback === "failed" ? completed : undefined,
    verdict: fallback,
  });
  if ("terminal" in decision) {
    d.run.verdict = decision.verdict;
    d.run.status = "done";
    d.run.current_nodes = [];
    return d;
  }
  d.run.iteration += 1;
  if (workflow.limits?.max_iterations && d.run.iteration > workflow.limits.max_iterations) {
    d.run.verdict = "limit-exceeded";
    d.run.status = "done";
    d.run.current_nodes = [];
    return d;
  }
  if (decision.failures !== undefined) d.run.failures = decision.failures;
  d.run.current_nodes = decision.next;
  return d;
}

export async function executeWorkflow(
  project: string,
  loaded: LoadedTemplate,
  runId: string,
): Promise<{ argv: string[]; shell: boolean; stdout: string; stderr: string; exit_code: number }> {
  const workflow = loaded.workflow;
  const docs = await readRun(project, runId);
  const node = docs.run.current_nodes[0];
  const nodeDef = nodeFor(workflow, node);
  if (nodeDef.type !== "graph" && nodeDef.type !== "validator" && nodeDef.type !== "command") {
    throw new GraphKitError("COMMAND_NOT_ALLOWED", `node '${node}' is not executable`);
  }
  const argv =
    nodeDef.type === "command" ? nodeDef.command : nodeDef.type === "graph" ? [nodeDef.operation] : nodeDef.checks;
  let stdout = "";
  let stderr = "";
  let exit_code = 0;
  if (nodeDef.type === "command") {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    exit_code = await proc.exited;
  } else if (nodeDef.type === "validator") {
    // Validator checks are declarative names; validation itself is handled by the template boundary.
    stdout = "";
  }
  await mutateRun(project, runId, (d) => {
    const cur = nodeFor(workflow, d.run.current_nodes[0]);
    if (cur.type !== "graph" && cur.type !== "validator" && cur.type !== "command")
      throw new GraphKitError("COMMAND_NOT_ALLOWED", `node '${d.run.current_nodes[0]}' is not executable`);
    const completed = d.run.current_nodes[0];
    const success = exit_code === 0;
    const decision = selectTransition({
      workflow,
      run: d.run,
      scope: scopeFor(workflow, d.run, d.state),
      completed,
      failed: success ? undefined : completed,
      verdict: success ? "passed" : "failed",
    });
    if ("terminal" in decision) {
      d.run.verdict = decision.verdict;
      d.run.status = "done";
      d.run.current_nodes = [];
      return d;
    }
    d.run.iteration += 1;
    if (workflow.limits?.max_iterations && d.run.iteration > workflow.limits.max_iterations) {
      d.run.verdict = "limit-exceeded";
      d.run.status = "done";
      d.run.current_nodes = [];
      return d;
    }
    if (decision.failures !== undefined) d.run.failures = decision.failures;
    d.run.current_nodes = decision.next;
    d.run.completed_deterministic_nodes = [...(d.run.completed_deterministic_nodes ?? []), completed];
    return d;
  });
  return { argv, shell: false, stdout, stderr, exit_code };
}
