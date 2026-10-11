import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedNode } from "../../src/compiler/plan.js";
import { planGraph } from "../../src/compiler/plan.js";
import { GraphKitError } from "../../src/errors.js";
import { runGraph } from "../../src/exec/engine.js";
import type { DispatchContext, DispatchOutcome, Runner } from "../../src/exec/types.js";
import { appendDispatch, appendNode, startRun } from "../../src/runs/ledger.js";
import { materializeNodeTrace, type TraceEvalEntry, traceForScope } from "../../src/runs/trace-eval.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

// Trace-level evaluation: eval-role nodes receive a materialized, scoped
// view of the run journal at dispatch time (.graphkit/runs/<id>/trace/
// <node>.jsonl) so they can grade actions, not just artifacts.

const ok = (output = "done"): DispatchOutcome => ({ ok: true, output, exitCode: 0, durationMs: 5 });
const fail = (output = "boom"): DispatchOutcome => ({ ok: false, output, exitCode: 1, durationMs: 5 });

class StubRunner implements Runner {
  calls: Array<{ id: string; objective: string; node: PlannedNode; ctx: DispatchContext }> = [];
  private script = new Map<string, DispatchOutcome[]>();
  on(id: string, ...outcomes: DispatchOutcome[]): this {
    this.script.set(id, outcomes);
    return this;
  }
  dispatches(id: string) {
    return this.calls.filter((c) => c.id === id);
  }
  async dispatch(node: PlannedNode, ctx: DispatchContext): Promise<DispatchOutcome> {
    this.calls.push({ id: node.id, objective: node.objective, node, ctx });
    const q = this.script.get(node.id);
    if (!q || q.length === 0) return ok();
    return q.length === 1 ? q[0] : q.shift()!;
  }
}

function gatedGraph() {
  return GraphSchema.parse({
    metadata: { name: "demo" },
    topology: "custom",
    nodes: {
      scouter: { agent: "scout", objective: "scout the repo", evidence: ["out"] },
      worker: { agent: "worker", objective: "work", depend_on: ["scouter"] },
      gate: {
        agent: "reviewer",
        objective: "grade the worker",
        role: "eval-gate",
        depend_on: ["worker"],
        eval: { prompt: "grade" },
      },
    },
  });
}

describe("trace-level evaluation", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-trace-eval-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: demo\ntopology: custom\n");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("plan: eval-gate payload carries the transitive depend_on scope; builders get null", () => {
    const plan = planGraph(gatedGraph());
    const flat = plan.waves.flatMap((w) => w.nodes);
    const gate = flat.find((n) => n.id === "gate")!;
    expect(gate.trace).toEqual({ scope: ["scouter", "worker"] });
    expect(flat.find((n) => n.id === "worker")!.trace).toBeNull();
    expect(flat.find((n) => n.id === "scouter")!.trace).toBeNull();
  });

  test("plan: role eval/advisor ride the same trace code path", () => {
    const g = GraphSchema.parse({
      metadata: { name: "demo" },
      topology: "custom",
      nodes: {
        worker: { agent: "w", objective: "work" },
        checker: { agent: "e", objective: "check", role: "eval", depend_on: ["worker"] },
        mentor: { agent: "a", objective: "advise", role: "advisor", depend_on: ["worker"] },
      },
    });
    const flat = planGraph(g).waves.flatMap((w) => w.nodes);
    expect(flat.find((n) => n.id === "checker")!.trace).toEqual({ scope: ["worker"] });
    expect(flat.find((n) => n.id === "mentor")!.trace).toEqual({ scope: ["worker"] });
  });

  test("dispatch: the trace file is materialized and the grader's objective points at it", async () => {
    const runner = new StubRunner().on("worker", fail("first try"), ok("second try"));
    const g = gatedGraph();
    g.nodes.worker.retry = { max_attempts: 2, initial_interval_ms: 1, backoff: 1, non_retryable: [] };
    const v = await runGraph(planGraph(g), { cwd, runner, graph: g } as never);
    expect(v.status).toBe("merged");

    const file = join(cwd, ".graphkit", "runs", v.runId, "trace", "gate.jsonl");
    expect(existsSync(file)).toBe(true);
    const entries = readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as TraceEvalEntry);

    // Content matches the journal: dispatches + per-attempt trace lines for
    // scoped nodes only — the gate's own events never appear in its file.
    const nodes = new Set(entries.map((e) => e.node));
    expect(nodes).toEqual(new Set(["scouter", "worker"]));
    expect(entries.filter((e) => e.kind === "dispatch").map((e) => e.node)).toContain("worker");
    const workerTrace = entries.filter((e) => e.kind === "trace" && e.node === "worker");
    expect(workerTrace.map((e) => e.status)).toEqual(["fail", "ok"]);
    expect(workerTrace.map((e) => e.attempt)).toEqual([1, 2]);
    expect(entries.every((e) => e.node !== "gate")).toBe(true);

    const gate = runner.dispatches("gate")[0];
    expect(gate.objective).toContain("## Run trace");
    expect(gate.objective).toContain(file);
  });

  test("materializeNodeTrace: missing run is a clean GraphKitError, not a crash", () => {
    expect(() => materializeNodeTrace(cwd, "20990101-000000-ghost", "gate", ["worker"])).toThrow(GraphKitError);
    expect(() => materializeNodeTrace(cwd, "20990101-000000-ghost", "gate", ["worker"])).toThrow(
      /TRACE_RUN_NOT_FOUND|no run "20990101-000000-ghost"/,
    );
  });

  test("traceForScope: empty scope yields an empty file; journal lines carry kind", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-01-01T00:00:00.000Z");
    appendDispatch(cwd, { node: "a", attempt: 1, via: "engine", pid: null });
    appendNode(cwd, {
      node: "a",
      wave: 0,
      agent: "w",
      model: "sonnet",
      status: "ok",
      evidence: ["out"],
      duration_ms: 3,
      notes: null,
    });
    const entries = traceForScope(cwd, id, ["a"]);
    expect(entries.map((e) => e.kind)).toEqual(["dispatch", "trace"]);
    expect(entries[1]).toMatchObject({ node: "a", status: "ok", evidence: ["out"] });
    // scope filtering: node b's journal is invisible to a-only scope
    appendNode(cwd, {
      node: "b",
      wave: 0,
      agent: "w",
      model: "sonnet",
      status: "ok",
      evidence: [],
      duration_ms: 1,
      notes: null,
    });
    expect(traceForScope(cwd, id, ["a"]).every((e) => e.node === "a")).toBe(true);
    expect(traceForScope(cwd, id, [])).toEqual([]);
  });
});
