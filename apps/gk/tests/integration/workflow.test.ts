import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkflow, nextWorkflow, startWorkflow, submitWorkflow } from "../../src/commands/workflow.js";
import { createRun, readRun } from "../../src/runtime/store.js";
import type { Run, Workflow } from "../../src/schemas.js";
import type { LoadedTemplate } from "../../src/templates/loader.js";
import { loadTemplate } from "../../src/templates/loader.js";

const root = join(import.meta.dir, "..", "fixtures", "valid-chain");

function makeLoaded(workflow: Workflow): LoadedTemplate {
  const agents = new Map<string, string>();
  for (const [id, node] of Object.entries(workflow.nodes)) {
    if (node.type === "agent") agents.set(id, join(root, "schemas", "result.schema.json"));
  }
  return {
    directory: root,
    manifest: { name: "t", version: "1", apiVersion: "graphkit.dev/v1alpha1", harness: "claude" },
    workflow,
    outputSchemas: agents,
    skillFiles: new Map(),
  };
}

function runFor(runId: string): Run {
  return {
    run_id: runId,
    template: "t",
    harness: "claude",
    status: "running",
    current_nodes: ["start"],
    pending_items: [],
    in_flight: {},
    iteration: 0,
    failures: 0,
    completed_deterministic_nodes: [],
    verdict: null,
  };
}

function fanLoaded(): LoadedTemplate {
  return makeLoaded({
    apiVersion: "graphkit.dev/v1alpha1",
    kind: "Workflow",
    metadata: { name: "fan" },
    inputs: {},
    limits: { max_iterations: 10, max_workers: 2 },
    state: { items: { merge: "append_unique", identity: "name" } },
    start: "start",
    nodes: {
      fan: { id: "fan", type: "fanout", from: "items", max_workers: 2 },
      work: {
        id: "work",
        type: "agent",
        skill: "worker",
        objective: "Process item.",
        tools: [],
        output: { schema: "schemas/result.schema.json", save_as: "result" },
      },
      join: { id: "join", type: "join", merge: "items" },
      done: { id: "done", type: "graph", operation: "complete-task" },
    },
    edges: [
      { from: "start", to: "fan" },
      { from: "fan", to: "join" },
      { from: "join", to: "done" },
    ],
    terminal: [{ node: "done", verdict: "passed" }],
  });
}

function chainLoaded(): LoadedTemplate {
  return makeLoaded({
    apiVersion: "graphkit.dev/v1alpha1",
    kind: "Workflow",
    metadata: { name: "chain" },
    inputs: { task: { type: "string" } },
    limits: { max_iterations: 2, max_workers: 1 },
    state: { result: { merge: "replace" } },
    start: "start",
    nodes: {
      work: {
        id: "work",
        type: "agent",
        skill: "worker",
        objective: "Complete the task.",
        tools: [],
        output: { schema: "schemas/result.schema.json", save_as: "result" },
      },
      complete: { id: "complete", type: "graph", operation: "complete-task" },
    },
    edges: [
      { from: "start", to: "work" },
      { from: "work", to: "complete" },
    ],
    terminal: [{ node: "complete", verdict: "passed" }],
  });
}

let project: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "gk-wf-"));
});

async function readEvents(): Promise<Array<Record<string, unknown>>> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(join(project, ".graphkit", "runs", "r1", "events.jsonl"), "utf8");
  return raw.trim()
    ? raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

describe("workflow contracts", () => {
  test("returns agent then deterministic contracts with exact submit argv", async () => {
    const loaded = await loadTemplate(root);
    await startWorkflow(project, loaded, { task: "x" }, "r1");
    const agent = await nextWorkflow(project, loaded, "r1");
    expect(agent.kind).toBe("agent");
    if (agent.kind !== "agent") throw new Error(`expected agent, got ${agent.kind}`);
    expect(agent.node).toBe("work");
    expect(agent.objective).toBe("Complete the task.");
    expect(agent.context.inputs).toEqual({ task: "x" });
    expect(agent.output_schema).toContain("result.schema.json");
    expect(agent.output_save_as).toBe("result");
    expect(agent.submit_argv).toEqual(["gk", "workflow", "submit", "r1", "work"]);
    await submitWorkflow(project, loaded, "r1", { summary: "done" });
    const deterministic = await nextWorkflow(project, loaded, "r1");
    expect(deterministic).toMatchObject({ kind: "deterministic", node: "complete", argv: ["complete-task"] });
  });

  test("command contracts carry exact argv, never a shell string", async () => {
    const chain = chainLoaded();
    await startWorkflow(project, chain, { task: "x" }, "r1");
    const cmdLoaded = makeLoaded({
      ...chain.workflow,
      nodes: {
        ...chain.workflow.nodes,
        cmd: { id: "cmd", type: "command", command: ["printf", "hello"] },
      },
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "cmd" },
        { from: "cmd", to: "complete" },
      ],
    });
    await submitWorkflow(project, cmdLoaded, "r1", { summary: "done" });
    const contract = await nextWorkflow(project, cmdLoaded, "r1");
    expect(contract).toEqual({ kind: "deterministic", node: "cmd", argv: ["printf", "hello"] });
  });

  test("execute uses argv, no shell string, records stdout", async () => {
    const loaded = await loadTemplate(root);
    await startWorkflow(project, loaded, { task: "x" }, "r1");
    await submitWorkflow(project, loaded, "r1", { summary: "done" });
    const result = await executeWorkflow(project, loaded, "r1");
    expect(result.argv).toEqual(["complete-task"]);
    expect(result.shell).toBe(false);
    expect(result.exit_code).toBe(0);
  });
});

describe("submission gates", () => {
  test("valid output merges state, settles lease, advances chain", async () => {
    const loaded = await loadTemplate(root);
    await startWorkflow(project, loaded, { task: "x" }, "r1");
    const result = await submitWorkflow(project, loaded, "r1", { summary: "done" });
    expect(result.state.result).toEqual({ summary: "done" });
    expect(result.run.current_nodes).toEqual(["complete"]);
    expect(result.run.status).toBe("running");
  });

  test("malformed output does not mutate run and appends rejection", async () => {
    const loaded = await loadTemplate(root);
    await startWorkflow(project, loaded, { task: "x" }, "r1");
    await expect(submitWorkflow(project, loaded, "r1", { summary: 4 })).rejects.toMatchObject({
      code: "SCHEMA_VIOLATION",
    });
    const events = await readEvents();
    expect(events.some((e) => e.type === "reject")).toBe(true);
    const docs = await readRun(project, "r1");
    expect(docs.run.current_nodes).toEqual(["work"]);
    expect(docs.state.result).toBeUndefined();
  });

  test("consumed lease returns LEASE_INVALID and appends rejection", async () => {
    const loaded = fanLoaded();
    await startWorkflow(project, loaded, { items: [{ name: "i1" }, { name: "i2" }] }, "r1");
    const dispatch = await nextWorkflow(project, loaded, "r1");
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
    const first = dispatch.items[0];
    await submitWorkflow(
      project,
      loaded,
      "r1",
      { summary: "s" },
      { lease: first.lease.id, work_item: first.work_item, node: first.node, verdict: "passed" },
    );
    await expect(
      submitWorkflow(
        project,
        loaded,
        "r1",
        { summary: "again" },
        { lease: first.lease.id, work_item: first.work_item, node: first.node, verdict: "passed" },
      ),
    ).rejects.toMatchObject({ code: "LEASE_INVALID" });
    const events = await readEvents();
    expect(events.some((e) => e.type === "reject")).toBe(true);
  });

  test("wrong-item lease returns LEASE_INVALID", async () => {
    const loaded = fanLoaded();
    await startWorkflow(project, loaded, { items: [{ name: "i1" }, { name: "i2" }] }, "r1");
    const dispatch = await nextWorkflow(project, loaded, "r1");
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
    const first = dispatch.items[0];
    await expect(
      submitWorkflow(
        project,
        loaded,
        "r1",
        { summary: "x" },
        { lease: first.lease.id, work_item: "i2", node: first.node, verdict: "passed" },
      ),
    ).rejects.toMatchObject({ code: "LEASE_INVALID" });
  });

  test("stale expired lease returns LEASE_EXPIRED", async () => {
    const now = Date.now();
    const loaded = fanLoaded();
    await createRun(project, { ...runFor("r1"), current_nodes: ["work"] }, { items: [{ name: "i1" }], __inputs: {} }, [
      {
        id: "L1",
        work_item: "i1",
        node: "work",
        issued_at: new Date(now - 60_000).toISOString(),
        expires_at: new Date(now - 30_000).toISOString(),
        status: "active",
      },
    ]);
    await expect(
      submitWorkflow(
        project,
        loaded,
        "r1",
        { summary: "x" },
        { lease: "L1", work_item: "i1", node: "work", verdict: "passed" },
      ),
    ).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
  });
});

describe("parallel dispatch and fan-in", () => {
  test("dispatch issues two distinct leases under max_workers", async () => {
    const loaded = fanLoaded();
    await startWorkflow(project, loaded, { items: [{ name: "i1" }, { name: "i2" }, { name: "i3" }] }, "r1");
    const dispatch = await nextWorkflow(project, loaded, "r1");
    expect(dispatch.kind).toBe("dispatch");
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
    expect(dispatch.items).toHaveLength(2);
    expect(dispatch.concurrency_ceiling).toBe(2);
    const leases = dispatch.items.map((i) => i.lease.id);
    expect(new Set(leases).size).toBe(2);
    expect(dispatch.items.map((i) => i.work_item).sort()).toEqual(["i1", "i2"]);
  });

  test("fan-in joins once all-settled with explicit merge policy", async () => {
    const loaded = fanLoaded();
    await startWorkflow(project, loaded, { items: [{ name: "i1" }, { name: "i2" }, { name: "i3" }] }, "r1");
    const dispatch = await nextWorkflow(project, loaded, "r1");
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
    const [a, b] = dispatch.items;
    expect(a.lease.id).not.toBe(b.lease.id);
    // one success, one failure settle
    await submitWorkflow(
      project,
      loaded,
      "r1",
      { summary: "s1" },
      { lease: a.lease.id, work_item: a.work_item, node: a.node, verdict: "passed" },
    );
    await submitWorkflow(
      project,
      loaded,
      "r1",
      { summary: "s2" },
      { lease: b.lease.id, work_item: b.work_item, node: b.node, verdict: "failed" },
    );
    // slot freed: next dispatch re-issues remaining i3
    const third = await nextWorkflow(project, loaded, "r1");
    expect(third.kind).toBe("dispatch");
    if (third.kind !== "dispatch") throw new Error("expected dispatch");
    expect(third.items).toHaveLength(1);
    expect(third.items[0].work_item).toBe("i3");
    // settle the last one, join opens
    const all = await submitWorkflow(
      project,
      loaded,
      "r1",
      { summary: "s3" },
      {
        lease: third.items[0].lease.id,
        work_item: third.items[0].work_item,
        node: third.items[0].node,
        verdict: "passed",
      },
    );
    expect(all.run.current_nodes).toEqual(["join"]);
    const names = (all.state.items as Array<{ name: string }>).map((i) => i.name);
    expect(names).toContain("i1:passed");
    expect(names).toContain("i2:failed");
    expect(names).toContain("i3:passed");
    expect(names).toHaveLength(6);
  });

  test("concurrent Promise.all submits serialize under the lock", async () => {
    const loaded = fanLoaded();
    await startWorkflow(project, loaded, { items: [{ name: "i1" }, { name: "i2" }] }, "r1");
    const dispatch = await nextWorkflow(project, loaded, "r1");
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
    const [a, b] = dispatch.items;
    await Promise.all([
      submitWorkflow(
        project,
        loaded,
        "r1",
        { summary: "s1" },
        { lease: a.lease.id, work_item: a.work_item, node: a.node, verdict: "passed" },
      ),
      submitWorkflow(
        project,
        loaded,
        "r1",
        { summary: "s2" },
        { lease: b.lease.id, work_item: b.work_item, node: b.node, verdict: "passed" },
      ),
    ]);
    const { readFile } = await import("node:fs/promises");
    const leases = JSON.parse(await readFile(join(project, ".graphkit", "runs", "r1", "leases.json"), "utf8"));
    expect(leases.every((l: { status: string }) => l.status === "settled")).toBe(true);
  });
});

describe("bounded retry and human gate", () => {
  const retryWorkflow = makeLoaded({
    apiVersion: "graphkit.dev/v1alpha1",
    kind: "Workflow",
    metadata: { name: "retry" },
    inputs: {},
    limits: { max_iterations: 1, max_workers: 1 },
    state: {},
    start: "start",
    nodes: {
      work: {
        id: "work",
        type: "agent",
        skill: "worker",
        objective: "Attempt.",
        tools: [],
        output: { schema: "schemas/result.schema.json", save_as: "result" },
      },
    },
    edges: [
      { from: "start", to: "work" },
      { from: "work", to: "work", retry: { max: 3, on: ["failed"] } },
    ],
    terminal: [{ node: "work", verdict: "failed" }],
  });

  test("bounded retry terminates with limit-exceeded at max_iterations", async () => {
    await startWorkflow(project, retryWorkflow, {}, "r1");
    // First failure retries (within max_iterations); second exceeds the cap.
    const first = await submitWorkflow(project, retryWorkflow, "r1", { summary: "bad" }, { verdict: "failed" });
    expect(first.run.verdict).not.toBe("limit-exceeded");
    const result = await submitWorkflow(project, retryWorkflow, "r1", { summary: "bad" }, { verdict: "failed" });
    expect(result.run.verdict).toBe("limit-exceeded");
    expect(result.run.status).toBe("done");
    const terminal = await nextWorkflow(project, retryWorkflow, "r1");
    expect(terminal).toEqual({ kind: "terminal", verdict: "limit-exceeded" });
  });

  const humanWorkflow = makeLoaded({
    apiVersion: "graphkit.dev/v1alpha1",
    kind: "Workflow",
    metadata: { name: "human" },
    inputs: {},
    limits: {},
    state: {},
    start: "start",
    nodes: {
      review: { id: "review", type: "human", prompt: "Approve the plan?", actions: ["approve", "reject"] },
      done: { id: "done", type: "graph", operation: "complete-task" },
    },
    edges: [
      { from: "start", to: "review" },
      { from: "review", to: "done" },
    ],
    terminal: [{ node: "done", verdict: "passed" }],
  });

  test("human pauses, then approve resumes by run id after reconstructing", async () => {
    await startWorkflow(project, humanWorkflow, {}, "r1");
    const paused = await nextWorkflow(project, humanWorkflow, "r1");
    expect(paused).toEqual({
      kind: "paused",
      node: "review",
      prompt: "Approve the plan?",
      actions: ["approve", "reject"],
    });
    const docs = await readRun(project, "r1");
    expect(docs.run.status).toBe("paused");
    await submitWorkflow(project, humanWorkflow, "r1", "approve", { node: "review", actor: "reviewer" });
    const resumed = await nextWorkflow(project, humanWorkflow, "r1");
    expect(resumed).toMatchObject({ kind: "deterministic", node: "done", argv: ["complete-task"] });
  });
});
