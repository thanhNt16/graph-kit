import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PlanGraph, PlannedNode, PlanWave } from "../compiler/plan.js";
import { GraphKitError } from "../errors.js";
import { addEvidence } from "../evidence/store.js";
import {
  activeRun,
  appendAdvisor,
  appendDispatch,
  appendNode,
  endRun,
  isNodeLine,
  readDispatches,
  readTrace,
  startRun,
  type TraceLine,
} from "../runs/ledger.js";
import { recordNodeRound } from "../runs/loops.js";
import type { Graph } from "../schemas/graph.schema.js";
import type { DispatchOutcome, InteractiveHooks, NodeRun, Runner, RunVerdict, WaveRun } from "./types.js";

// The deterministic core: wave iteration with a hard barrier, the round
// journal for looping nodes, advisor escalation, fan-out briefs, upstream
// budgeting and the evidence stamp path - all behind the Runner seam so the
// engine never knows whether it is talking to the host task tool or a
// spawn'd child process. Ledger writes are snake_case at this boundary; the
// Runner's DispatchOutcome is camelCase by its own contract.

/** The orchestrator's judgment seam: `when` predicates and `loop.stop_when`
 *  conditions. Headless engines omit it - every predicate evaluates false
 *  (the safe reading: run the node, stop the loop at max_rounds). */
export type JudgeFn = (
  node: PlannedNode,
  predicate: string,
  upstream: ReadonlyMap<string, NodeRun>,
) => boolean | Promise<boolean>;

export interface RunGraphOptions {
  cwd: string;
  runner: Runner;
  runId?: string;
  interactive?: InteractiveHooks;
  /** Parsed graph - required only for the evidence stamp path (addEvidence
   *  validates declared keys and reads outputs.evidence_dir). Nodes with
   *  declared evidence and no graph surface a warning and keep running. */
  graph?: Graph;
  /** graph.yaml path for a fresh startRun; defaults to <cwd>/graph.yaml. */
  graphPath?: string;
  judge?: JudgeFn;
}

const DEFAULT_EVIDENCE_DIR = ".graphkit/evidence";
const INJECTION_PREFIX = "INJECTION:";
/** Last non-empty line of a node's output: `CHALLENGE: <node-id|plan> — <finding>`. */
const CHALLENGE_RE = /^CHALLENGE:\s*(\S+)\s+—\s*(.+)$/u;
const UPSTREAM_HEAD = 240;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const lastLines = (output: string): string[] =>
  output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

function retryDelayMs(retry: PlannedNode["retry"], attempt: number): number {
  return (retry?.initial_interval_ms ?? 1000) * (retry?.backoff ?? 2) ** (attempt - 1);
}

function failNotes(outcome: DispatchOutcome): string {
  return outcome.timedOut ? `timeout after ${outcome.durationMs}ms` : `exit=${outcome.exitCode}`;
}

/** Compaction keeps the verdict-relevant skeleton of an upstream node
 *  (status + evidence marker + a head of its output) and drops the bulk;
 *  the full text is spilled to disk by contextFor. */
function compactUpstream(run: NodeRun): string {
  const output = (run.outcome?.output ?? "").trim();
  return `[${run.id}] status=${run.status} evidence=${output.length > 0 ? "stamped" : "none"} :: ${output.slice(0, UPSTREAM_HEAD)}${output.length > UPSTREAM_HEAD ? "…" : ""}`;
}

function renderUpstream(run: NodeRun): string {
  return `## ${run.id} — ${run.status}\n${(run.outcome?.output ?? "").trim()}`;
}

/** Brief template render: `{brief.title}` / `{brief.body}` (any `brief.X`
 *  field) substituted; unknown fields render empty. */
function renderBrief(template: string, brief: Record<string, unknown>): string {
  return template.replace(/\{brief\.(\w+)\}/gu, (_, field: string) => {
    const v = brief[field];
    return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  });
}

export async function runGraph(plan: PlanGraph, opts: RunGraphOptions): Promise<RunVerdict> {
  const { cwd, runner, judge, interactive, graph } = opts;
  const runId = opts.runId ? attachRun(cwd, opts.runId) : startRun(cwd, opts.graphPath ?? join(cwd, "graph.yaml")).id;
  const evidenceDir = graph?.outputs.evidence_dir ?? DEFAULT_EVIDENCE_DIR;

  const nodeRuns = new Map<string, NodeRun>();
  const waves: WaveRun[] = [];
  const stampedKeys = new Map<string, string[]>();
  let injection: string | null = null;
  let gateUnapproved = false;
  let challengeSeen = false;

  // -- ledger adapters -----------------------------------------------------

  /** Attaching requires the target run to BE the active run: two engines
   *  sharing one cwd would otherwise interleave trace lines into two runs. */
  function attachRun(cwd: string, id: string): string {
    const dir = activeRun(cwd);
    const active = dir ? basename(dir) : null;
    if (active !== id)
      throw new GraphKitError(
        "RUN_NOT_ACTIVE",
        `run "${id}" is not the active run${active ? ` (active: ${active})` : " (no active run)"}`,
      );
    return id;
  }

  function traceLine(
    node: PlannedNode,
    status: TraceLine["status"],
    waveIndex: number | null,
    fields: { outcome?: DispatchOutcome; notes?: string | null; attempt?: number | null } = {},
  ): void {
    appendNode(cwd, {
      node: node.id,
      wave: waveIndex,
      agent: node.agent,
      model: node.model ?? null,
      status,
      evidence: stampedKeys.get(node.id) ?? [],
      duration_ms: fields.outcome?.durationMs ?? null,
      notes: fields.notes ?? (fields.outcome && !fields.outcome.ok ? failNotes(fields.outcome) : null),
      attempt: fields.attempt ?? undefined,
    });
  }

  /** One node's terminal fate: ledger-facing NodeRun + host notification.
   *  `trace=false` when the trace line was already appended (dispatch
   *  failures trace per attempt; challenge stamps its own line). */
  function finish(
    node: PlannedNode,
    wave: PlanWave,
    status: Exclude<NodeRun["status"], "landed">,
    attempts: number,
    outcome?: DispatchOutcome,
    notes?: string | null,
    trace = true,
  ): NodeRun {
    if (trace) traceLine(node, status, wave.index, { outcome, notes, attempt: attempts > 0 ? attempts : null });
    const run: NodeRun = { id: node.id, wave: wave.index, status, outcome, attempts };
    nodeRuns.set(node.id, run);
    interactive?.onNodeResult(run);
    if (status !== "skipped") runNodeHooks(node);
    return run;
  }

  /** `hooks.on_node_complete` command strings - a best-effort integration
   *  seam, never a run-killer: hook failures land on stderr. */
  function runNodeHooks(node: PlannedNode): void {
    for (const cmd of node.hooks) {
      try {
        execSync(cmd.replaceAll("{node}", node.id), { cwd, stdio: "pipe" });
      } catch (e) {
        console.error(`[engine] hook failed for ${node.id}: ${(e as Error).message}`);
      }
    }
  }

  // -- evidence stamps -----------------------------------------------------

  /** Evidence contract per declared key: one non-whitespace artifact in the
   *  run's evidence dir, stamped via addEvidence (marker carries the repo
   *  fingerprint + active run id). The dispatch output is the artifact
   *  body; an empty output still yields a non-whitespace placeholder. */
  async function stampEvidence(node: PlannedNode, outcome: DispatchOutcome): Promise<string[]> {
    const keys: string[] = [];
    for (const key of node.evidence) {
      const source = join(cwd, ".graphkit", "runs", runId, "evidence", `${key}.md`);
      mkdirSync(dirname(source), { recursive: true });
      const body =
        outcome.output.trim().length > 0
          ? outcome.output
          : `(node ${node.id} completed without output for key "${key}")`;
      writeFileSync(source, body.endsWith("\n") ? body : `${body}\n`);
      if (!graph) {
        console.error(
          `[engine] node ${node.id} declares evidence "${key}" but no parsed graph was passed - stamp skipped`,
        );
        continue;
      }
      try {
        addEvidence(cwd, graph, { file: source, key, node: node.id });
        keys.push(key);
      } catch (e) {
        console.error(`[engine] evidence stamp failed for ${node.id}/${key}: ${(e as Error).message}`);
      }
    }
    stampedKeys.set(node.id, keys);
    return keys;
  }

  // -- dispatch ------------------------------------------------------------

  /** Dispatch + retry loop. Failed attempts trace immediately (evidence
   *  empty, notes=exit/timeout); a successful attempt is stamped THEN traced
   *  so the ok line carries its evidence keys. Infrastructure failures (a
   *  throwing Runner) are retryable like any transient dispatch error;
   *  prompt/parse/validation errors are the caller's job, not retried here. */
  async function dispatchNode(
    target: PlannedNode,
    upstream: Map<string, NodeRun>,
    waveIndex: number | null,
    okNotes: (outcome: DispatchOutcome) => string | null = () => null,
    record = true,
  ): Promise<{ outcome: DispatchOutcome; attempts: number }> {
    const retry = target.retry;
    const maxAttempts = Math.max(1, retry?.max_attempts ?? 1);
    for (let attempt = 1; ; attempt++) {
      if (record) appendDispatch(cwd, { node: target.id, attempt, via: "engine", pid: null });
      let outcome: DispatchOutcome;
      try {
        outcome = await runner.dispatch(target, { runId, cwd, node: target, upstream, attempt });
      } catch (e) {
        outcome = { ok: false, output: e instanceof Error ? e.message : String(e), exitCode: -1, durationMs: 0 };
      }
      if (!outcome.ok) {
        if (record) traceLine(target, "fail", waveIndex, { outcome, attempt });
        // A non_retryable substring makes the failure fatal on this attempt:
        // prompt/parse/validation errors never benefit from another round.
        const fatal = (retry?.non_retryable ?? []).some(
          (s) => s.length > 0 && outcome.output.toLowerCase().includes(s.toLowerCase()),
        );
        if (fatal || attempt >= maxAttempts) return { outcome, attempts: attempt };
        await sleep(retryDelayMs(retry, attempt));
        continue;
      }
      if (record) await stampEvidence(target, outcome);
      if (record) traceLine(target, "ok", waveIndex, { outcome, attempt, notes: okNotes(outcome) });
      return { outcome, attempts: attempt };
    }
  }

  // -- orchestration features ----------------------------------------------

  const judgePredicate = (node: PlannedNode, predicate: string, upstream: ReadonlyMap<string, NodeRun>) =>
    judge ? judge(node, predicate, upstream) : Promise.resolve(false);

  /** Upstream context within budget_tokens (chars ~= tokens*4): compact
   *  per-node skeletons when over, spill the full render to
   *  .graphkit/artifacts/<node>-input.md and pass the path in the objective. */
  function contextFor(
    node: PlannedNode,
    upstream: ReadonlyMap<string, NodeRun>,
  ): { upstream: Map<string, NodeRun>; spillNote: string | null } {
    if (node.budget_tokens == null) return { upstream: new Map(upstream), spillNote: null };
    const full = [...upstream.values()].map(renderUpstream).join("\n\n");
    if (full.length <= node.budget_tokens * 4) return { upstream: new Map(upstream), spillNote: null };
    const compacted = new Map<string, NodeRun>(
      [...upstream.values()].map((r) => [
        r.id,
        { ...r, outcome: r.outcome ? { ...r.outcome, output: compactUpstream(r) } : undefined },
      ]),
    );
    mkdirSync(join(cwd, ".graphkit", "artifacts"), { recursive: true });
    const spill = join(cwd, ".graphkit", "artifacts", `${node.id}-input.md`);
    writeFileSync(spill, full);
    return {
      upstream: compacted,
      spillNote: `Full upstream context exceeded budget_tokens=${node.budget_tokens}; per-node full text: ${spill}`,
    };
  }

  function detectChallenge(outcome: DispatchOutcome): { target: string; finding: string; line: string } | null {
    const lines = lastLines(outcome.output);
    const m = lines[lines.length - 1]?.match(CHALLENGE_RE);
    return m ? { target: m[1], finding: m[2], line: lines[lines.length - 1]! } : null;
  }

  function parseInjection(output: string): string | null {
    const lines = lastLines(output);
    const last = lines[lines.length - 1];
    if (last === undefined || !last.toUpperCase().startsWith(INJECTION_PREFIX)) {
      console.error(`[engine] curator output missing "${INJECTION_PREFIX}" line - treating as null injection`);
      return null;
    }
    const value = last.slice(INJECTION_PREFIX.length).trim();
    return value.length === 0 || value.toLowerCase() === "null" ? null : value;
  }

  /** Read-only escalation when a looping node keeps failing: dispatched
   *  through the same Runner with a no_write constraint, journaled via
   *  appendAdvisor, never traced as a node of its own. */
  async function dispatchAdvisor(
    node: PlannedNode,
    upstream: Map<string, NodeRun>,
    lastOutcome: DispatchOutcome,
    streak: number,
    round: number,
  ): Promise<string | null> {
    const advisor = node.advisor!;
    const target: PlannedNode = {
      ...node,
      id: `${node.id}-advisor`,
      model: advisor.model,
      objective: [
        `Read-only diagnosis for looping node "${node.id}": round ${round} failed (streak ${streak}).`,
        `Node objective: ${node.objective}`,
        `Last round output:\n${lastOutcome.output.trim()}`,
        "Respond with a short root-cause diagnosis and THE single next action for the next round.",
      ].join("\n\n"),
      constraints: [...(node.constraints ?? []), { no_write: true }],
      when: null,
      gate: null,
      loop: null,
      advisor: null,
      fan_out: null,
      evidence: [],
      hooks: [],
      timeout_ms: null,
    };
    const { outcome } = await dispatchNode(target, upstream, null, () => null, false);
    appendAdvisor(cwd, { node: node.id, round, tier: advisor.model, streak });
    if (!outcome.ok) {
      console.error(`[engine] advisor dispatch for ${node.id} failed - continuing without guidance`);
      return null;
    }
    return outcome.output.trim();
  }

  /** fan_out: read [{id,title,body}] briefs from the source node's evidence,
   *  dispatch every brief as a parallel sub-task (no per-brief trace lines -
   *  the parent node traces once), join outputs in brief order. Missing or
   *  malformed briefs are a failed round, not a crash.
   *
   *  ponytail: fan.reduce (append/merge/vote) rides as plain append; the
   *  vote/merge reducers need multi-run aggregation semantics nobody has
   *  specified yet - add when a graph actually declares them. */
  async function runFanOut(
    node: PlannedNode,
    wave: PlanWave,
    upstream: Map<string, NodeRun>,
  ): Promise<{ outcome: DispatchOutcome; attempts: number }> {
    const fan = node.fan_out!;
    // The fan source publishes its briefs as evidence/briefs.json — the
    // convention, not a per-source filename (one briefs.json per evidence dir).
    const briefsFile = join(cwd, evidenceDir, "briefs.json");
    let briefs: unknown;
    try {
      briefs = JSON.parse(readFileSync(briefsFile, "utf-8"));
    } catch (e) {
      return {
        outcome: {
          ok: false,
          output: `briefs-unreadable: ${fan.briefs_from}.json (${(e as Error).message})`,
          exitCode: -1,
          durationMs: 0,
        },
        attempts: 0,
      };
    }
    if (!Array.isArray(briefs) || briefs.length === 0)
      return {
        outcome: {
          ok: false,
          output: `briefs-malformed: ${fan.briefs_from}.json is not a non-empty brief array`,
          exitCode: -1,
          durationMs: 0,
        },
        attempts: 0,
      };

    const dispatched = await Promise.all(
      briefs.map((raw, i) => {
        const brief = (raw ?? {}) as Record<string, unknown>;
        const id = typeof brief.id === "string" && brief.id.trim() ? brief.id.trim() : `n${i}`;
        const target: PlannedNode = {
          ...node,
          id: `${node.id}-${id}`,
          objective: renderBrief(fan.template, brief),
          when: null,
          gate: null,
          loop: null,
          advisor: null,
          fan_out: null,
          evidence: [],
          hooks: [],
        };
        return dispatchNode(target, upstream, null, () => null, false);
      }),
    );
    const attempts = dispatched.reduce((n, d) => n + d.attempts, 0);
    const durationMs = Math.max(0, ...dispatched.map((d) => d.outcome.durationMs));
    const output = dispatched.map((d) => d.outcome.output.trim()).join("\n\n");
    const failed = dispatched.filter((d) => !d.outcome.ok);
    if (failed.length > 0)
      return {
        outcome: {
          ok: false,
          output: `${failed.length}/${dispatched.length} brief dispatches failed:\n${failed.map((f) => f.outcome.output).join("\n---\n")}`,
          exitCode: failed[0]!.outcome.exitCode,
          durationMs,
        },
        attempts,
      };
    const joined: DispatchOutcome = { ok: true, output, exitCode: 0, durationMs };
    await stampEvidence(node, joined);
    traceLine(node, "ok", wave.index, { outcome: joined, attempt: attempts });
    return { outcome: joined, attempts };
  }

  // -- node + wave execution -----------------------------------------------

  async function runCurator(wave: PlanWave): Promise<NodeRun> {
    const node = wave.nodes[0];
    if (node == null) throw new GraphKitError("BAD_PLAN", "curator wave carries no node");
    const forbidden = plan.memory?.null_intervention_allowed === false;
    const target: PlannedNode = {
      ...node,
      objective: [
        node.objective,
        `You MUST end your response with a final line "${INJECTION_PREFIX} <one-line reminder for the next action wave>".`,
        `A null intervention is ${forbidden ? "FORBIDDEN - surface something actionable" : `allowed (emit "${INJECTION_PREFIX} null")`}.`,
      ].join("\n"),
    };
    const { outcome, attempts } = await dispatchNode(
      target,
      new Map(),
      wave.index,
      (o) => `injection=${parseInjection(o.output) ?? "null"}`,
    );
    if (!outcome.ok) return finish(node, wave, "fail", attempts, outcome, undefined, false);
    const reminder = parseInjection(outcome.output);
    if (reminder === null && forbidden)
      return finish(node, wave, "fail", attempts, outcome, "null-intervention-forbidden", false);
    if (reminder !== null) injection = reminder;
    return finish(node, wave, "ok", attempts, outcome, undefined, false);
  }

  async function runAction(wave: PlanWave, node: PlannedNode, memoryPrefix: string): Promise<NodeRun> {
    const skippedDep = node.depend_on.find((d) => nodeRuns.get(d)?.status === "skipped");
    if (skippedDep) return finish(node, wave, "skipped", 0, undefined, `upstream-skipped:${skippedDep}`);

    if (node.when != null && !(await judgePredicate(node, node.when, new Map(nodeRuns))))
      return finish(node, wave, "skipped", 0, undefined, "when-false");

    if (node.gate != null) {
      const approved = interactive?.askGate ? await interactive.askGate(node, node.gate) : false;
      if (!approved) {
        gateUnapproved = true;
        return finish(
          node,
          wave,
          "skipped",
          0,
          undefined,
          interactive?.askGate ? "gate-declined" : "gate-auto-skipped",
        );
      }
    }

    const { upstream, spillNote } = contextFor(node, new Map([...nodeRuns].filter(([, r]) => r.outcome != null)));
    const loop = node.loop?.enabled === true ? node.loop : null;
    const maxRounds = loop ? Math.max(1, loop.max_rounds) : 1;
    let guidance = "";
    let advisorCalls = 0;
    let totalAttempts = 0;
    let streak = 0;

    for (let round = 1; round <= maxRounds; round++) {
      const objective = [
        `${memoryPrefix}${node.objective}`,
        spillNote,
        guidance.length > 0 ? `## Advisor guidance\n${guidance}` : null,
      ]
        .filter((s): s is string => s != null)
        .join("\n\n");
      const target: PlannedNode = { ...node, objective };

      const { outcome, attempts } =
        node.fan_out != null ? await runFanOut(node, wave, upstream) : await dispatchNode(target, upstream, wave.index);
      totalAttempts += attempts;

      if (outcome.ok) {
        const challenge = detectChallenge(outcome);
        if (challenge) {
          challengeSeen = true;
          const verdict = interactive?.askChallenge ? await interactive.askChallenge(challenge.line) : "defer";
          // The stamp targets the node the finding is about; "plan" lands on
          // the dispatcher so the line never orphans.
          const tracedId = challenge.target === "plan" ? node.id : challenge.target;
          appendNode(cwd, {
            node: tracedId,
            wave: wave.index,
            agent: node.agent,
            model: node.model ?? null,
            status: "challenge",
            evidence: stampedKeys.get(node.id) ?? [],
            duration_ms: null,
            notes: `target=${challenge.target} disposition=${verdict} ${challenge.finding}`,
          });
          return finish(node, wave, "challenge", totalAttempts, outcome, undefined, false);
        }
        if (loop?.stop_when == null || (await judgePredicate(target, loop.stop_when, new Map(nodeRuns))))
          return finish(node, wave, "ok", totalAttempts, outcome, undefined, false);
      }

      // Failed round (or ok-but-loop-continuing): journal it, escalate to
      // the advisor when the streak crosses the threshold, then next round.
      const rr = loop == null ? null : recordNodeRound(cwd, node.id, { maxRounds, evidenceDir });
      if (rr?.stop_reason === "max_rounds")
        return finish(node, wave, "fail", totalAttempts, outcome, `loop-exhausted:${round}`);
      if (!loop) return finish(node, wave, "fail", totalAttempts, outcome, undefined, false);

      streak++;
      if (node.advisor != null && streak >= node.advisor.after_failed_rounds && advisorCalls < node.advisor.max_calls) {
        advisorCalls++;
        const g = await dispatchAdvisor(node, upstream, outcome, streak, round);
        if (g != null) guidance = g;
      }
    }
    // Unreachable: every round path returns, or continues up to maxRounds.
    throw new GraphKitError("ENGINE_LOOP_ESCAPED", `node ${node.id} escaped its round loop`);
  }

  try {
    for (const wave of plan.waves) {
      interactive?.onWaveStart(wave);
      const waveRun: WaveRun = { index: wave.index, curator: wave.curator === true, nodes: [] };
      waves.push(waveRun);
      if (wave.curator === true) {
        waveRun.nodes.push(await runCurator(wave));
        continue;
      }
      const prefix = injection != null ? `[memory] ${injection}\n` : "";
      injection = null;
      waveRun.nodes.push(...(await Promise.all(wave.nodes.map((n) => runAction(wave, n, prefix)))));
      // Hard barrier: a failed wave stops the graph before the next one.
      if (waveRun.nodes.some((n) => n.status === "fail")) break;
    }
    const all = [...nodeRuns.values()];
    const status: RunVerdict["status"] = all.some((n) => n.status === "fail")
      ? "failed"
      : gateUnapproved || challengeSeen || all.some((n) => n.status === "challenge")
        ? "blocked"
        : "merged";
    // Dispatch intents without a matching trace line: the run crashed
    // between the pre-dispatch record and the result append.
    const traced = new Set(
      readTrace(cwd, runId)
        .filter(isNodeLine)
        .map((l) => l.node),
    );
    const unresolved = readDispatches(cwd, runId)
      .map((d) => d.node)
      .filter((n) => n.length > 0 && !traced.has(n));
    const verdict: RunVerdict = { status, runId, waves, nodes: all, unresolved };
    try {
      endRun(cwd, status);
    } catch (e) {
      console.error(`[engine] endRun failed: ${(e as Error).message}`);
    }
    return verdict;
  } catch (e) {
    try {
      if (activeRun(cwd)) endRun(cwd, "failed");
    } catch (endErr) {
      console.error(`[engine] endRun(failed) also failed: ${(endErr as Error).message}`);
    }
    throw e;
  }
}
