import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkflow, nextWorkflow, startWorkflow, submitWorkflow } from "../../src/commands/workflow.js";
import { createRun, mutateRun, readRun } from "../../src/runtime/store.js";
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
        output: { schema: "schemas/result.schema.json", save_as: "result", evidence: [] },
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
        output: { schema: "schemas/result.schema.json", save_as: "result", evidence: [] },
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

  test("join advances to aggregator agent with full contract", async () => {
    const loaded = makeLoaded({
      apiVersion: "graphkit.dev/v1alpha1",
      kind: "Workflow",
      metadata: { name: "agg" },
      inputs: {},
      limits: { max_iterations: 10, max_workers: 2 },
      state: { items: { merge: "append_unique", identity: "name" }, result: { merge: "replace" } },
      start: "start",
      nodes: {
        fan: { id: "fan", type: "fanout", from: "items", max_workers: 2 },
        work: {
          id: "work",
          type: "agent",
          skill: "worker",
          objective: "Process item.",
          tools: [],
          output: { schema: "schemas/result.schema.json", save_as: "result", evidence: [] },
        },
        join: { id: "join", type: "join", merge: "items" },
        summarize: {
          id: "summarize",
          type: "agent",
          skill: "worker",
          objective: "Aggregate item results.",
          tools: [],
          output: { schema: "schemas/result.schema.json", save_as: "result", evidence: [] },
        },
        done: { id: "done", type: "graph", operation: "complete-task" },
      },
      edges: [
        { from: "start", to: "fan" },
        { from: "fan", to: "join" },
        { from: "join", to: "summarize" },
        { from: "summarize", to: "done" },
      ],
      terminal: [{ node: "done", verdict: "passed" }],
    });
    await startWorkflow(project, loaded, { items: [{ name: "i1" }, { name: "i2" }] }, "r1");
    const dispatch = await nextWorkflow(project, loaded, "r1");
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
    const [a, b] = dispatch.items;
    await submitWorkflow(
      project,
      loaded,
      "r1",
      { summary: "s1" },
      { lease: a.lease.id, work_item: a.work_item, verdict: "passed" },
    );
    await submitWorkflow(
      project,
      loaded,
      "r1",
      { summary: "s2" },
      { lease: b.lease.id, work_item: b.work_item, verdict: "passed" },
    );
    const agg = await nextWorkflow(project, loaded, "r1");
    expect(agg.kind).toBe("agent");
    if (agg.kind !== "agent") throw new Error(`expected agent, got ${agg.kind}`);
    expect(agg.node).toBe("summarize");
    expect(agg.objective).toBe("Aggregate item results.");
    expect(agg.output_schema).toContain("result.schema.json");
    expect(agg.output_save_as).toBe("result");
    expect(agg.submit_argv).toEqual(["gk", "workflow", "submit", "r1", "summarize"]);
    await submitWorkflow(project, loaded, "r1", { summary: "all done" }, { actor: "aggregator" });
    const after = await readRun(project, "r1");
    expect(after.state.result).toEqual({ summary: "all done" });
    expect(after.run.current_nodes).toEqual(["done"]);
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
    const events = await readEvents();
    const submit = events.find((e) => e.type === "submit");
    expect(submit).toMatchObject({ type: "submit", actor: "worker" });
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
      { lease: first.lease.id, work_item: first.work_item, verdict: "passed" },
    );
    await expect(
      submitWorkflow(
        project,
        loaded,
        "r1",
        { summary: "again" },
        { lease: first.lease.id, work_item: first.work_item, verdict: "passed" },
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
        { lease: first.lease.id, work_item: "i2", verdict: "passed" },
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
        { lease: "L1", work_item: "i1", verdict: "passed" },
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

  test("waits at fanout while one required item remains in flight", async () => {
    const loaded = fanLoaded();
    await startWorkflow(project, loaded, { items: [{ name: "i1" }, { name: "i2" }] }, "r1");
    const dispatch = await nextWorkflow(project, loaded, "r1");
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
    const [a] = dispatch.items;
    await submitWorkflow(
      project,
      loaded,
      "r1",
      { summary: "s1" },
      { lease: a.lease.id, work_item: a.work_item, verdict: "passed" },
    );
    const wait = await nextWorkflow(project, loaded, "r1");
    expect(wait.kind).toBe("dispatch");
    if (wait.kind !== "dispatch") throw new Error("expected dispatch wait");
    expect(wait.items).toEqual([]);
    expect((await readRun(project, "r1")).run.current_nodes).toEqual(["fan"]);
    expect((await readRun(project, "r1")).run.verdict).toBeNull();
  });

  test("concurrent next at join advances exactly once", async () => {
    const raceLoaded = makeLoaded({
      apiVersion: "graphkit.dev/v1alpha1",
      kind: "Workflow",
      metadata: { name: "race" },
      inputs: {},
      limits: { max_iterations: 1, max_workers: 2 },
      state: { items: { merge: "append_unique", identity: "name" }, result: { merge: "replace" } },
      start: "start",
      nodes: {
        fan: { id: "fan", type: "fanout", from: "items", max_workers: 2 },
        work: {
          id: "work",
          type: "agent",
          skill: "worker",
          objective: "Process.",
          tools: [],
          output: { schema: "schemas/result.schema.json", save_as: "result", evidence: [] },
        },
        join: { id: "join", type: "join", merge: "items" },
        summarize: {
          id: "summarize",
          type: "agent",
          skill: "worker",
          objective: "Aggregate.",
          tools: [],
          output: { schema: "schemas/result.schema.json", save_as: "result", evidence: [] },
        },
        done: { id: "done", type: "graph", operation: "complete-task" },
      },
      edges: [
        { from: "start", to: "fan" },
        { from: "fan", to: "join" },
        { from: "join", to: "summarize" },
        { from: "summarize", to: "done" },
      ],
      terminal: [{ node: "done", verdict: "passed" }],
    });
    await startWorkflow(project, raceLoaded, { items: [{ name: "i1" }, { name: "i2" }] }, "r1");
    const d = await nextWorkflow(project, raceLoaded, "r1");
    if (d.kind !== "dispatch") throw new Error("expected dispatch");
    const [a, b] = d.items;
    await submitWorkflow(
      project,
      raceLoaded,
      "r1",
      { summary: "s1" },
      { lease: a.lease.id, work_item: a.work_item, verdict: "passed" },
    );
    await submitWorkflow(
      project,
      raceLoaded,
      "r1",
      { summary: "s2" },
      { lease: b.lease.id, work_item: b.work_item, verdict: "passed" },
    );
    // now at join: two concurrent next calls
    const results = await Promise.all([
      nextWorkflow(project, raceLoaded, "r1"),
      nextWorkflow(project, raceLoaded, "r1"),
    ]);
    const docs = await readRun(project, "r1");
    expect(docs.run.current_nodes).toEqual(["summarize"]);
    expect(docs.run.iteration).toBe(1);
    for (const r of results) expect(r.kind).toBe("agent");
    const { readdir, readFile } = await import("node:fs/promises");
    const cpDir = join(project, ".graphkit", "runs", "r1", "checkpoints");
    const cps = (await readdir(cpDir)).filter((f) => f.endsWith(".json")).filter((f) => f.startsWith("000"));
    const joins = JSON.parse(await readFile(join(cpDir, cps.at(-1) as string), "utf8"));
    void joins;
    const events = await readEvents();
    const joinEvents = events.filter((e) => e.node === "join" && e.type === "command");
    expect(joinEvents.length).toBe(1);
  });

  test("fanout with ambiguous agent worker rejects", async () => {
    const ambiguous = makeLoaded({
      apiVersion: "graphkit.dev/v1alpha1",
      kind: "Workflow",
      metadata: { name: "ambiguous" },
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
          objective: "Process.",
          tools: [],
          output: { schema: "schemas/result.schema.json", save_as: "result", evidence: [] },
        },
        work2: {
          id: "work2",
          type: "agent",
          skill: "worker",
          objective: "Process too.",
          tools: [],
          output: { schema: "schemas/result.schema.json", save_as: "result2", evidence: [] },
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
    await startWorkflow(project, ambiguous, { items: [{ name: "i1" }] }, "r1");
    await expect(nextWorkflow(project, ambiguous, "r1")).rejects.toMatchObject({ code: "SCHEMA_VIOLATION" });
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
      { lease: a.lease.id, work_item: a.work_item, verdict: "passed" },
    );
    await submitWorkflow(
      project,
      loaded,
      "r1",
      { summary: "s2" },
      { lease: b.lease.id, work_item: b.work_item, verdict: "failed" },
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

  test("concurrent Promise.all next calls never double-issue a lease", async () => {
    const loaded = fanLoaded();
    await startWorkflow(project, loaded, { items: [{ name: "i1" }, { name: "i2" }, { name: "i3" }] }, "r1");
    const results = await Promise.all([nextWorkflow(project, loaded, "r1"), nextWorkflow(project, loaded, "r1")]);
    const dispatches = results.filter((r) => r.kind === "dispatch");
    expect(dispatches.length).toBeGreaterThan(0);
    const leased = dispatches.flatMap((d) => d.items.map((i) => i.work_item));
    expect(new Set(leased).size).toBe(leased.length);
    // no duplicate active lease per work item
    const docs = await readRun(project, "r1");
    const inflight = Object.values(docs.run.in_flight ?? {});
    expect(new Set(inflight).size).toBe(inflight.length);
  });

  test("expired in-flight lease is recovered, reissued, and old submission rejected", async () => {
    const now = Date.now();
    const loaded = fanLoaded();
    await createRun(
      project,
      { ...runFor("r1"), current_nodes: ["fan"] },
      { items: [{ name: "i1" }], __inputs: {}, __fan_items__items: [{ name: "i1" }] },
      [
        {
          id: "L1",
          work_item: "i1",
          node: "work",
          issued_at: new Date(now - 60_000).toISOString(),
          expires_at: new Date(now - 30_000).toISOString(),
          status: "active",
        },
      ],
    );
    await mutateRun(project, "r1", (d) => {
      Object.assign(d.run.in_flight, { i1: "L1" });
      return d;
    });
    const reissue = await nextWorkflow(project, loaded, "r1");
    expect(reissue.kind).toBe("dispatch");
    if (reissue.kind !== "dispatch") throw new Error("expected dispatch");
    expect(reissue.items.map((i) => i.work_item)).toEqual(["i1"]);
    const fresh = reissue.items[0].lease;
    expect(fresh.id).not.toBe("L1");
    const docs = await readRun(project, "r1");
    const expired = docs.leases.find((l) => l.id === "L1");
    expect(expired?.status).toBe("expired");
    expect(docs.leases.find((l) => l.id === fresh.id)?.status).toBe("active");
    await expect(
      submitWorkflow(
        project,
        loaded,
        "r1",
        { summary: "x" },
        { lease: "L1", work_item: "i1", verdict: "passed" },
      ),
    ).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    const events = await readEvents();
    expect(events.some((e) => e.type === "reject" && e.lease === "L1")).toBe(true);
  });

  test("post-dispatch expiry reissues while fanout remains authoritative", async () => {
    const loaded = fanLoaded();
    await startWorkflow(project, loaded, { items: [{ name: "i1" }] }, "r1");
    const first = await nextWorkflow(project, loaded, "r1");
    if (first.kind !== "dispatch") throw new Error("expected dispatch");
    expect((await readRun(project, "r1")).run.current_nodes).toEqual(["fan"]);
    // Make the active lease stale without changing the cursor.
    await mutateRun(project, "r1", (d) => {
      const lease = d.leases[0];
      lease.expires_at = new Date(Date.now() - 1).toISOString();
      return d;
    });
    const replacement = await nextWorkflow(project, loaded, "r1");
    expect(replacement.kind).toBe("dispatch");
    if (replacement.kind !== "dispatch") throw new Error("expected dispatch");
    expect(replacement.items).toHaveLength(1);
    expect(replacement.items[0].lease.id).not.toBe(first.items[0].lease.id);
    expect((await readRun(project, "r1")).run.current_nodes).toEqual(["fan"]);
  });

  test("submit after run advanced to non-agent node is rejected with provenance", async () => {
    const loaded = await loadTemplate(root);
    await startWorkflow(project, loaded, { task: "x" }, "r1");
    await submitWorkflow(project, loaded, "r1", { summary: "done" });
    // Run has advanced to `complete`; a late submit must reject rather than mutate.
    await expect(submitWorkflow(project, loaded, "r1", { summary: "late" })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    const docs = await readRun(project, "r1");
    expect(docs.run.current_nodes).toEqual(["complete"]);
    expect(docs.run.verdict).toBeNull();
    const reject = (await readEvents()).filter((e) => e.type === "reject").at(-1);
    expect(reject).toMatchObject({
      type: "reject",
      node: "complete",
      actor: "system",
      details: { code: "INVALID_TRANSITION" },
    });
  });

  test("worker submit event and latest checkpoint carry lease and actor", async () => {
    const loaded = fanLoaded();
    await startWorkflow(project, loaded, { items: [{ name: "i1" }, { name: "i2" }] }, "r1");
    const dispatch = await nextWorkflow(project, loaded, "r1");
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
    const a = dispatch.items[0];
    await submitWorkflow(
      project,
      loaded,
      "r1",
      { summary: "s1" },
      { lease: a.lease.id, work_item: a.work_item, verdict: "passed", actor: "worker" },
    );
    const events = await readEvents();
    const submit = events.find((e) => e.type === "submit" && e.lease === a.lease.id);
    expect(submit).toMatchObject({ type: "submit", lease: a.lease.id, actor: "worker" });
    const { readdir, readFile } = await import("node:fs/promises");
    const cpDir = join(project, ".graphkit", "runs", "r1", "checkpoints");
    const newest = (await readdir(cpDir))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .at(-1) as string;
    const cp = JSON.parse(await readFile(join(cpDir, newest), "utf8"));
    expect(cp.provenance.actor).toBe("worker");
    expect(cp.provenance.lease).toBe(a.lease.id);
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
        { lease: a.lease.id, work_item: a.work_item, verdict: "passed" },
      ),
      submitWorkflow(
        project,
        loaded,
        "r1",
        { summary: "s2" },
        { lease: b.lease.id, work_item: b.work_item, verdict: "passed" },
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
        output: { schema: "schemas/result.schema.json", save_as: "result", evidence: [] },
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
    await submitWorkflow(project, humanWorkflow, "r1", "approve", { actor: "reviewer" });
    const resumed = await nextWorkflow(project, humanWorkflow, "r1");
    expect(resumed).toMatchObject({ kind: "deterministic", node: "done", argv: ["complete-task"] });
  });
});
