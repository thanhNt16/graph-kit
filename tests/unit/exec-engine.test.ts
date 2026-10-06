import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedNode } from "../../src/compiler/plan.js";
import { planGraph } from "../../src/compiler/plan.js";
import { GraphKitError } from "../../src/errors.js";
import { runGraph } from "../../src/exec/engine.js";
import type { DispatchContext, DispatchOutcome, InteractiveHooks, Runner } from "../../src/exec/types.js";
import {
  activeRun,
  appendDispatch,
  isNodeLine,
  readAdvisorEvents,
  readRunIndex,
  readTrace,
  startRun,
} from "../../src/runs/ledger.js";
import { readRoundJournals } from "../../src/runs/loops.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

// Task 3 contract: runGraph(plan, opts) drives a PlanGraph through a Runner
// seam and lands every write in the run ledger. The stub Runner is
// runner-agnostic proof — the engine never learns whether dispatches came
// from a task tool or a child process. Concurrency is proven deterministically:
// the stub parks dispatches for `barrierIds` until all of them are in flight,
// so parallel waves deadlock unless the engine really dispatches concurrently.

const ok = (output = "done"): DispatchOutcome => ({ ok: true, output, exitCode: 0, durationMs: 5 });
const fail = (output = "boom", exitCode = 1): DispatchOutcome => ({ ok: false, output, exitCode, durationMs: 5 });

class StubRunner implements Runner {
  calls: Array<{ id: string; objective: string; ctx: DispatchContext }> = [];
  maxInFlight = 0;
  /** Dispatches for these ids park until all of them are in flight together. */
  barrierIds: string[] = [];
  private script = new Map<string, DispatchOutcome[]>();
  private inFlight = 0;
  private parked: Array<() => void> = [];

  on(id: string, ...outcomes: DispatchOutcome[]): this {
    this.script.set(id, outcomes);
    return this;
  }

  dispatches(id: string): Array<{ id: string; objective: string; ctx: DispatchContext }> {
    return this.calls.filter((c) => c.id === id);
  }

  async dispatch(node: PlannedNode, ctx: DispatchContext): Promise<DispatchOutcome> {
    this.calls.push({ id: node.id, objective: node.objective, ctx });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.barrierIds.includes(node.id) && this.inFlight < this.barrierIds.length) {
        const { promise, resolve } = Promise.withResolvers<void>();
        this.parked.push(resolve);
        await promise;
      } else if (this.parked.length > 0) {
        for (const release of this.parked.splice(0)) release();
      }
      const q = this.script.get(node.id);
      if (!q || q.length === 0) return ok();
      return q.length === 1 ? q[0] : q.shift()!;
    } finally {
      this.inFlight--;
    }
  }
}

const hooks = (over: Partial<InteractiveHooks> = {}): InteractiveHooks => ({
  onWaveStart() {},
  onNodeResult() {},
  ...over,
});

function diamond() {
  return GraphSchema.parse({
    metadata: { name: "demo" },
    topology: "diamond",
    nodes: {
      scouter: { agent: "scout", objective: "scout the repo", evidence: ["out"] },
      "worker-a": { agent: "worker", objective: "work a", depend_on: ["scouter"] },
      "worker-b": { agent: "worker", objective: "work b", depend_on: ["scouter"] },
      synthesizer: { agent: "synth", objective: "synthesize", depend_on: ["worker-a", "worker-b"] },
    },
  });
}

function memoryGraph() {
  return GraphSchema.parse({
    metadata: { name: "mem" },
    topology: "memory-augmented",
    nodes: {
      a1: { agent: "worker", objective: "first" },
      a2: { agent: "worker", objective: "second", depend_on: ["a1"] },
      curator: { agent: "memory-curator", objective: "curate" },
    },
  });
}

describe("exec engine — runGraph", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-engine-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: demo\ntopology: diamond\n");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const run = (graph: Parameters<typeof planGraph>[0], runner: Runner, extra: Record<string, unknown> = {}) =>
    runGraph(planGraph(graph), { cwd, runner, graph, ...extra } as never);

  test("waves run in order with a hard barrier; verdict + ledger land merged", async () => {
    const runner = new StubRunner();
    const v = await run(diamond(), runner);

    expect(v.status).toBe("merged");
    expect(v.runId).toMatch(/^\d{8}-\d{6}-demo/);
    const order = runner.calls.map((c) => c.id);
    expect(order.indexOf("scouter")).toBeLessThan(order.indexOf("worker-a"));
    expect(order.indexOf("scouter")).toBeLessThan(order.indexOf("worker-b"));
    expect(Math.max(order.indexOf("worker-a"), order.indexOf("worker-b"))).toBeLessThan(order.indexOf("synthesizer"));
    // barrier: synth dispatched only after both workers finished ok upstream
    const synth = runner.dispatches("synthesizer")[0];
    expect(synth.ctx.upstream.get("worker-a")?.status).toBe("ok");
    expect(synth.ctx.upstream.get("worker-b")?.status).toBe("ok");
    expect(synth.ctx.attempt).toBe(1);
    expect(synth.ctx.runId).toBe(v.runId);
    expect(v.waves.map((w) => w.index)).toEqual([0, 1, 2]);
    expect(v.waves.every((w) => w.curator === false)).toBe(true);
    // ledger: one ok trace line per node, index line merged, pointer cleared
    const lines = readTrace(cwd, v.runId).filter(isNodeLine);
    expect(lines.map((l) => l.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(lines.every((l) => typeof l.duration_ms === "number")).toBe(true);
    expect(readRunIndex(cwd).at(-1)?.status).toBe("merged");
    expect(activeRun(cwd)).toBeNull();
    const scouter = v.nodes.find((n) => n.id === "scouter")!;
    expect(scouter).toMatchObject({ wave: 0, status: "ok", attempts: 1 });
  });

  test("wave parallelism is real: a serial engine deadlocks on the 2-dispatch barrier", async () => {
    const runner = new StubRunner();
    runner.barrierIds = ["worker-a", "worker-b"]; // both workers must be in flight together
    const v = await run(diamond(), runner);
    expect(v.status).toBe("merged");
    expect(runner.maxInFlight).toBe(2);
  });

  test("ok nodes get one stamped non-whitespace evidence artifact per declared key", async () => {
    const runner = new StubRunner().on("scouter", ok("## Findings\nthree things"));
    const v = await run(diamond(), runner);
    const evidenceDir = join(cwd, ".graphkit", "evidence");
    const marker = readFileSync(join(evidenceDir, "out.md"), "utf-8");
    expect(marker.trim().length).toBeGreaterThan(0);
    expect(marker).toContain("key: out");
    expect(marker).toContain("node: scouter");
    expect(marker).toContain(`run_id: ${v.runId}`);
    const artifacts = readdirSync(join(evidenceDir, "out"));
    expect(artifacts).toHaveLength(1);
    expect(readFileSync(join(evidenceDir, "out", artifacts[0]), "utf-8")).toContain("three things");
    expect(
      readTrace(cwd, v.runId)
        .filter(isNodeLine)
        .find((l) => l.node === "scouter")?.evidence,
    ).toEqual(["out"]);
  });

  test("a failed node stops the graph with failed", async () => {
    const runner = new StubRunner().on("worker-a", fail("exploded"));
    const v = await run(diamond(), runner);
    expect(v.status).toBe("failed");
    expect(runner.dispatches("synthesizer")).toHaveLength(0);
    expect(runner.dispatches("worker-b")).toHaveLength(1); // wave-1 sibling still ran to the barrier
    expect(v.nodes.find((n) => n.id === "worker-a")?.status).toBe("fail");
    expect(readRunIndex(cwd).at(-1)?.status).toBe("failed");
    expect(activeRun(cwd)).toBeNull();
  });

  test("when:false skips the node and cascades to its dependents", async () => {
    const g = diamond();
    g.nodes["worker-a"].when = "no security findings upstream";
    const runner = new StubRunner();
    const v = await run(g, runner); // no judge → headless predicate = false
    expect(runner.dispatches("worker-a")).toHaveLength(0);
    expect(v.nodes.find((n) => n.id === "worker-a")?.status).toBe("skipped");
    expect(v.nodes.find((n) => n.id === "synthesizer")?.status).toBe("skipped");
    expect(v.nodes.find((n) => n.id === "worker-b")?.status).toBe("ok");
    expect(v.status).toBe("merged"); // skips are recorded, never silent, not blocking
    const line = readTrace(cwd, v.runId)
      .filter(isNodeLine)
      .find((l) => l.node === "worker-a");
    expect(line?.status).toBe("skipped");
    expect(line?.notes).toContain("when");
  });

  test("judge override can hold `when` true and dispatch the node", async () => {
    const g = diamond();
    g.nodes["worker-a"].when = "audit found findings";
    const runner = new StubRunner();
    const v = await run(g, runner, { judge: (_n, predicate) => predicate.includes("findings") });
    expect(v.nodes.find((n) => n.id === "worker-a")?.status).toBe("ok");
  });

  test("retry: transient failures exhaust to fail with every attempt traced", async () => {
    const g = diamond();
    g.nodes["worker-a"].retry = { max_attempts: 3, initial_interval_ms: 1, backoff: 1, non_retryable: [] };
    const runner = new StubRunner().on("worker-a", fail("net down"), fail("net down"), fail("net down"));
    const v = await run(g, runner);
    expect(runner.dispatches("worker-a")).toHaveLength(3);
    expect(v.nodes.find((n) => n.id === "worker-a")).toMatchObject({ status: "fail", attempts: 3 });
    const lines = readTrace(cwd, v.runId)
      .filter(isNodeLine)
      .filter((l) => l.node === "worker-a");
    expect(lines.map((l) => l.attempt)).toEqual([1, 2, 3]);
    expect(lines.every((l) => l.status === "fail")).toBe(true);
  });

  test("retry: a non_retryable substring is fatal on the first hit", async () => {
    const g = diamond();
    g.nodes["worker-a"].retry = {
      max_attempts: 3,
      initial_interval_ms: 1,
      backoff: 1,
      non_retryable: ["SCHEMA_INVALID"],
    };
    const runner = new StubRunner().on("worker-a", fail("SCHEMA_INVALID: bad payload"));
    const v = await run(g, runner);
    expect(runner.dispatches("worker-a")).toHaveLength(1);
    expect(v.status).toBe("failed");
  });

  test("retry: transient then ok recovers to merged", async () => {
    const g = diamond();
    g.nodes["worker-a"].retry = { max_attempts: 3, initial_interval_ms: 1, backoff: 1, non_retryable: [] };
    const runner = new StubRunner().on("worker-a", fail("blip"), fail("blip"), ok("recovered"));
    const v = await run(g, runner);
    expect(v.status).toBe("merged");
    expect(v.nodes.find((n) => n.id === "worker-a")).toMatchObject({ status: "ok", attempts: 3 });
  });

  test("loop: unmet stop_when re-dispatches to max_rounds then fails, journal durable", async () => {
    const g = diamond();
    g.nodes["worker-a"].loop = { enabled: true, stop_when: "tests pass", max_rounds: 3 };
    const runner = new StubRunner().on("worker-a", ok("still red"));
    const v = await run(g, runner);
    expect(runner.dispatches("worker-a")).toHaveLength(3);
    expect(v.nodes.find((n) => n.id === "worker-a")).toMatchObject({ status: "fail", attempts: 3 });
    expect(v.status).toBe("failed");
    const journals = readRoundJournals(cwd, v.runId);
    expect(journals).toHaveLength(1);
    expect(journals[0].lines.map((l) => l.round)).toEqual([1, 2, 3]);
  });

  test("loop: satisfied stop_when stops after the first round", async () => {
    const g = diamond();
    g.nodes["worker-a"].loop = { enabled: true, stop_when: "tests pass", max_rounds: 4 };
    const runner = new StubRunner().on("worker-a", ok("green"));
    const v = await run(g, runner, { judge: (_n, predicate) => predicate.includes("pass") });
    expect(runner.dispatches("worker-a")).toHaveLength(1);
    expect(v.status).toBe("merged");
    expect(readRoundJournals(cwd, v.runId)).toHaveLength(0);
  });

  test("advisor fires at the failed-round streak and steers the next round", async () => {
    const g = diamond();
    g.nodes["worker-a"].loop = { enabled: true, stop_when: "green build", max_rounds: 4 };
    g.nodes["worker-a"].advisor = { model: "fable", after_failed_rounds: 1, max_calls: 2 };
    const runner = new StubRunner()
      .on("worker-a", ok("red"), ok("green build"))
      .on("worker-a-advisor", ok("diagnosis: the fixture is stale"));
    const v = await run(g, runner, {
      judge: (node, predicate) => predicate.includes("green build") && node.objective.includes("Advisor guidance"),
    });
    expect(v.status).toBe("merged");
    // advisor dispatched read-only before round 2
    const adv = runner.dispatches("worker-a-advisor");
    expect(adv).toHaveLength(1);
    expect(adv[0].ctx.node.constraints).toContainEqual({ no_write: true });
    expect(adv[0].objective).toContain("round 1 failed");
    // guidance appended to the next round's objective at the ORIGINAL model tier
    const round2 = runner.dispatches("worker-a")[1];
    expect(round2.objective).toContain("## Advisor guidance");
    expect(round2.objective).toContain("diagnosis: the fixture is stale");
    expect(round2.ctx.node.model).toBe("sonnet");
    expect(round2.ctx.node.id).toBe("worker-a");
    // escalation recorded in advisor.jsonl
    expect(readAdvisorEvents(cwd, v.runId)).toEqual([
      { at: expect.any(String), node: "worker-a", round: 1, tier: "fable", streak: 1 },
    ]);
  });

  test("gate: approval dispatches, rejection and headless absence skip to blocked", async () => {
    const g = diamond();
    g.nodes.synthesizer.gate = { question: "Ship it?" };

    const asked: string[] = [];
    const yesRunner = new StubRunner();
    const yes = await run(g, yesRunner, {
      interactive: hooks({
        askGate: async (n) => {
          asked.push(n.id);
          return true;
        },
      }),
    });
    expect(asked).toEqual(["synthesizer"]);
    expect(yes.status).toBe("merged");
    expect(yesRunner.dispatches("synthesizer")).toHaveLength(1);

    const no = await run(g, new StubRunner(), {
      interactive: hooks({ askGate: async () => false }),
    });
    expect(no.nodes.find((n) => n.id === "synthesizer")?.status).toBe("skipped");
    expect(no.status).toBe("blocked");

    const headless = await run(g, new StubRunner());
    expect(headless.nodes.find((n) => n.id === "synthesizer")?.status).toBe("skipped");
    expect(headless.status).toBe("blocked"); // auto-skip still demands the human
  });

  test("challenge: CHALLENGE line is adjudicated, traced with disposition, blocks the run", async () => {
    const runner = new StubRunner().on("worker-a", ok("done\nCHALLENGE: scouter — the premise is stale"));
    let asked = "";
    const v = await run(diamond(), runner, {
      interactive: hooks({
        askChallenge: async (finding) => {
          asked = finding;
          return "accept";
        },
      }),
    });
    expect(asked).toContain("CHALLENGE: scouter");
    const line = readTrace(cwd, v.runId)
      .filter(isNodeLine)
      .find((l) => l.status === "challenge");
    expect(line?.node).toBe("scouter");
    expect(line?.notes).toContain("disposition=accept");
    expect(v.nodes.find((n) => n.id === "worker-a")?.status).toBe("challenge");
    expect(v.status).toBe("blocked"); // engine holds no judgment — blocked pending the host
  });

  test("challenge: headless runs record disposition=defer and still block", async () => {
    const runner = new StubRunner().on("scouter", ok("done\nCHALLENGE: plan — DAG ordering is wrong"));
    const v = await run(diamond(), runner);
    const line = readTrace(cwd, v.runId)
      .filter(isNodeLine)
      .find((l) => l.status === "challenge");
    expect(line?.node).toBe("scouter"); // plan challenges trace under the dispatching node
    expect(line?.notes).toContain("target=plan");
    expect(line?.notes).toContain("disposition=defer");
    expect(v.status).toBe("blocked");
  });

  test("curator wave dispatches memory-curator and prepends INJECTION to the next action wave", async () => {
    const runner = new StubRunner().on(
      "curator",
      ok("analysis…\nINJECTION: check the routing lexicon"),
      ok("INJECTION: null"),
    );
    const v = await run(memoryGraph(), runner);
    expect(v.status).toBe("merged");
    expect(v.waves.filter((w) => w.curator)).toHaveLength(2);
    const a2 = runner.dispatches("a2")[0];
    expect(a2.objective.startsWith("[memory] check the routing lexicon")).toBe(true);
    expect(a2.objective).toContain("second");
    const cur = readTrace(cwd, v.runId)
      .filter(isNodeLine)
      .filter((l) => l.node === "curator");
    expect(cur).toHaveLength(2);
    expect(cur[0].notes).toContain("injection=check the routing lexicon");
    expect(cur[1].notes).toContain("injection=null");
  });

  test("curator: null intervention forbidden makes a null injection fail the run", async () => {
    const g = GraphSchema.parse({
      metadata: { name: "mem" },
      topology: "memory-augmented",
      topology_config: { memory: { null_intervention_allowed: false } },
      nodes: {
        a1: { agent: "worker", objective: "first" },
        curator: { agent: "memory-curator", objective: "curate" },
      },
    });
    const runner = new StubRunner().on("curator", ok("INJECTION: null"));
    const v = await run(g, runner);
    expect(v.status).toBe("failed");
    expect(v.nodes.find((n) => n.id === "curator")?.status).toBe("fail");
  });

  test("fan_out: briefs dispatch in parallel and reduce into the node output", async () => {
    const g = GraphSchema.parse({
      metadata: { name: "demo" },
      topology: "diamond",
      nodes: {
        planner: { agent: "plan", objective: "plan" },
        fan: {
          agent: "worker",
          objective: "fan out",
          depend_on: ["planner"],
          fan_out: { briefs_from: "planner", template: "Do {brief.title}: {brief.body}" },
        },
      },
    });
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(
      join(cwd, ".graphkit", "evidence", "briefs.json"),
      JSON.stringify([
        { id: "b1", title: "T1", body: "B1" },
        { id: "b2", title: "T2", body: "B2" },
      ]),
    );
    const runner = new StubRunner();
    runner.barrierIds = ["fan-b1", "fan-b2"]; // both briefs must be in flight together
    runner.on("fan-b1", ok("brief one output: B1"));
    runner.on("fan-b2", ok("brief two output: B2"));
    const v = await run(g, runner);
    expect(v.status).toBe("merged");
    const briefCalls = runner.calls.filter((c) => c.id.startsWith("fan-"));
    expect(briefCalls.map((c) => c.id).sort()).toEqual(["fan-b1", "fan-b2"]);
    expect(briefCalls.map((c) => c.objective).sort()).toEqual(["Do T1: B1", "Do T2: B2"]);
    const fan = v.nodes.find((n) => n.id === "fan")!;
    expect(fan.status).toBe("ok");
    expect(fan.attempts).toBe(2);
    expect(fan.outcome?.output).toContain("B1");
    expect(fan.outcome?.output).toContain("B2");
  });

  test("fan_out: missing or malformed briefs.json is a failed round", async () => {
    const g = GraphSchema.parse({
      metadata: { name: "demo" },
      topology: "diamond",
      nodes: {
        planner: { agent: "plan", objective: "plan" },
        fan: { agent: "worker", objective: "fan out", depend_on: ["planner"], fan_out: { briefs_from: "planner" } },
      },
    });
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "evidence", "briefs.json"), "{not json");
    const runner = new StubRunner();
    const v = await run(g, runner);
    expect(v.status).toBe("failed");
    const fan = v.nodes.find((n) => n.id === "fan")!;
    expect(fan.status).toBe("fail");
    expect(fan.outcome?.output).toContain("briefs");
  });

  test("fan_out: empty briefs array is a successful no-op round", async () => {
    const g = GraphSchema.parse({
      metadata: { name: "demo" },
      topology: "diamond",
      nodes: {
        planner: { agent: "plan", objective: "plan" },
        fan: { agent: "worker", objective: "fan out", depend_on: ["planner"], fan_out: { briefs_from: "planner" } },
      },
    });
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "evidence", "briefs.json"), "[]");
    const runner = new StubRunner();
    const v = await run(g, runner);
    expect(v.status).toBe("merged");
    const fan = v.nodes.find((n) => n.id === "fan")!;
    expect(fan.status).toBe("ok");
    expect(fan.outcome?.output).toBe("no briefs");
    expect(runner.calls.filter((c) => c.id.startsWith("fan-"))).toHaveLength(0); // nothing dispatched
  });

  test("fan_out: valid JSON that is not an array is briefs-malformed", async () => {
    const g = GraphSchema.parse({
      metadata: { name: "demo" },
      topology: "diamond",
      nodes: {
        planner: { agent: "plan", objective: "plan" },
        fan: { agent: "worker", objective: "fan out", depend_on: ["planner"], fan_out: { briefs_from: "planner" } },
      },
    });
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(
      join(cwd, ".graphkit", "evidence", "briefs.json"),
      JSON.stringify({ id: "b1", title: "T", body: "B" }),
    );
    const runner = new StubRunner();
    const v = await run(g, runner);
    expect(v.status).toBe("failed");
    const fan = v.nodes.find((n) => n.id === "fan")!;
    expect(fan.status).toBe("fail");
    expect(fan.outcome?.output).toContain("briefs-malformed");
  });

  test("budget_tokens: oversized upstream context compacts per node and spills the full text", async () => {
    const g = diamond();
    g.nodes["worker-a"].budget_tokens = 100;
    const runner = new StubRunner().on("scouter", ok("x".repeat(2000)));
    const v = await run(g, runner);
    const ctx = runner.dispatches("worker-a")[0].ctx;
    const compacted = ctx.upstream.get("scouter")!.outcome!.output;
    expect(compacted.length).toBeLessThan(400);
    expect(compacted).toContain("scouter");
    expect(compacted).toContain("status=ok");
    const spill = join(cwd, ".graphkit", "artifacts", "worker-a-input.md");
    const spilled = readFileSync(spill, "utf-8");
    expect(spilled).toContain("## scouter — ok"); // full render, not the compact skeleton
    expect(spilled).toContain("x".repeat(1000));
    expect(runner.dispatches("worker-a")[0].objective).toContain("worker-a-input.md");
    expect(v.status).toBe("merged");
  });

  test("runId attaches to the live run; dispatch intents without trace lines surface as unresolved", async () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"));
    appendDispatch(cwd, { node: "ghost", attempt: 1, via: "task", pid: null });
    const v = await run(diamond(), new StubRunner(), { runId: id });
    expect(v.runId).toBe(id);
    expect(v.unresolved).toEqual(["ghost"]);
    expect(readRunIndex(cwd).at(-1)?.id).toBe(id); // engine ended the attached run
    expect(activeRun(cwd)).toBeNull();
  });

  test("attaching to a run that is not active fails with RUN_NOT_ACTIVE", async () => {
    try {
      await run(diamond(), new StubRunner(), { runId: "20260101-000000-demo" });
      throw new Error("expected RUN_NOT_ACTIVE");
    } catch (e) {
      expect(e).toBeInstanceOf(GraphKitError);
      expect((e as GraphKitError).code).toBe("RUN_NOT_ACTIVE");
    }
  });

  test("node hooks run post-dispatch with {node} substituted", async () => {
    const g = diamond();
    g.hooks.on_node_complete = ["echo hooked-{node} > .hook-{node}.txt"];
    const v = await run(g, new StubRunner());
    expect(existsSync(join(cwd, ".hook-scouter.txt"))).toBe(true);
    expect(readFileSync(join(cwd, ".hook-scouter.txt"), "utf-8").trim()).toBe("hooked-scouter");
    expect(readFileSync(join(cwd, ".hook-synthesizer.txt"), "utf-8").trim()).toBe("hooked-synthesizer");
    expect(v.status).toBe("merged");
  });
});
