import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import { materializeNodeAgents } from "../../src/cli/node-agents.js";
import type { PlannedNode } from "../../src/compiler/plan.js";
import { budgetRemainingByNode, planGraph } from "../../src/compiler/plan.js";
import { runGraph } from "../../src/exec/engine.js";
import type { DispatchContext, DispatchOutcome, InteractiveHooks, Runner } from "../../src/exec/types.js";
import { isNodeLine, readRunMeta, readTrace } from "../../src/runs/ledger.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

// Run-level context budget: `budget: {max_tokens, warn_at}` on the graph is a
// planning-currency cap over the SUM of dispatched nodes' declared
// budget_tokens — recorded into meta.json at startRun, enforced by the
// engine with stop_reason "budget_exceeded", surfaced by `gk run status`,
// and injected into each node brief as a model-visible "Context budget
// remaining" advisory line.

const ok = (output = "done"): DispatchOutcome => ({ ok: true, output, exitCode: 0, durationMs: 5 });

class StubRunner implements Runner {
  calls: Array<{ id: string; objective: string; ctx: DispatchContext }> = [];
  async dispatch(node: PlannedNode, ctx: DispatchContext): Promise<DispatchOutcome> {
    this.calls.push({ id: node.id, objective: node.objective, ctx });
    return ok();
  }
}

const hooks = (over: Partial<InteractiveHooks> = {}): InteractiveHooks => ({
  onWaveStart() {},
  onNodeResult() {},
  ...over,
});

function budgetGraph(max = 100, warnAt = 0.8) {
  return GraphSchema.parse({
    metadata: { name: "budgeted" },
    topology: "custom",
    budget: { max_tokens: max, warn_at: warnAt },
    nodes: {
      first: { agent: "worker", objective: "step one", budget_tokens: 60 },
      second: { agent: "worker", objective: "step two", depend_on: ["first"], budget_tokens: 60 },
      free: { agent: "worker", objective: "no allocation", depend_on: ["second"] },
    },
  });
}

function runCli(args: string[], cwd: string) {
  const cli = cac("gk");
  registerRunCommands(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  const origExit = process.exit;
  let exitCode = 0;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  process.exit = (c?: number) => {
    exitCode = c ?? 1;
  };
  process.chdir(cwd);
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.chdir(origCwd);
  }
  const code = process.exitCode ? Number(process.exitCode) : exitCode;
  process.exitCode = 0;
  return { stdout: logs.join("\n"), code };
}

describe("run-level context budget", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-budget-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: budgeted\ntopology: custom\n");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("schema: budget block parses, warn_at defaults, stays optional", () => {
    const g = budgetGraph(500);
    expect(g.budget).toEqual({ max_tokens: 500, warn_at: 0.8 });
    const plain = GraphSchema.parse({
      metadata: { name: "plain" },
      topology: "custom",
      nodes: { a: { agent: "w", objective: "x" } },
    });
    expect(plain.budget).toBeUndefined();
    const bad = GraphSchema.safeParse({
      metadata: { name: "bad" },
      topology: "custom",
      budget: { max_tokens: -5 },
      nodes: { a: { agent: "w", objective: "x" } },
    });
    expect(bad.success).toBe(false);
  });

  test("plan: budget rides the plan and injects a cumulative remaining line per node", () => {
    const plan = planGraph(budgetGraph(100));
    expect(plan.budget).toEqual({ max_tokens: 100, warn_at: 0.8 });
    const byId = Object.fromEntries(plan.waves.flatMap((w) => w.nodes.map((n) => [n.id, n.objective])));
    // first charges 60 → 40 left; second charges 60 more → -20 (over cap, unclamped)
    expect(byId.first).toContain("Context budget remaining: 40 tokens");
    expect(byId.second).toContain("Context budget remaining: -20 tokens");
    // free declares nothing — the running total does not move
    expect(byId.free).toContain("Context budget remaining: -20 tokens");
  });

  test("plan: graphs without budget carry no line and no plan.budget", () => {
    const plain = GraphSchema.parse({
      metadata: { name: "plain" },
      topology: "custom",
      nodes: { a: { agent: "w", objective: "x" } },
    });
    const plan = planGraph(plain);
    expect(plan.budget).toBeUndefined();
    expect(plan.waves[0].nodes[0].objective).not.toContain("Context budget");
    expect(budgetRemainingByNode(plain)).toBeNull();
  });

  test("engine: dispatch exceeding the cap stops the run with budget_exceeded", async () => {
    const runner = new StubRunner();
    const graph = budgetGraph(100); // first 60 fits; second 60 would reach 120
    const v = await runGraph(planGraph(graph), { cwd, runner, graph });

    expect(v.status).toBe("failed");
    expect(v.stop_reason).toBe("budget_exceeded");
    expect(v.nodes.find((n) => n.id === "first")?.status).toBe("ok");
    expect(v.nodes.find((n) => n.id === "second")?.status).toBe("fail");
    expect(v.nodes.find((n) => n.id === "free")).toBeUndefined(); // wave 2 never ran
    // the tripping node was never dispatched, and downstream nodes never ran
    expect(runner.calls.map((c) => c.id)).toEqual(["first"]);
    // the trace records which node tripped the cap
    const line = readTrace(cwd, v.runId)
      .filter(isNodeLine)
      .find((l) => l.node === "second");
    expect(line?.status).toBe("fail");
    expect(line?.notes).toContain("budget_exceeded");
    // and the run's meta recorded the graph's declared budget
    expect(readRunMeta(cwd, v.runId).budget).toEqual({ max_tokens: 100, warn_at: 0.8 });
  });

  test("engine: allocations within the cap merge cleanly; no stop_reason", async () => {
    const runner = new StubRunner();
    const graph = budgetGraph(120); // 60 + 60 = exactly the cap
    const v = await runGraph(planGraph(graph), { cwd, runner, graph });
    expect(v.status).toBe("merged");
    expect(v.stop_reason).toBeUndefined();
    expect(runner.calls.map((c) => c.id)).toEqual(["first", "second", "free"]);
  });

  test("engine: skipped nodes never charge the budget", async () => {
    const runner = new StubRunner();
    const graph = GraphSchema.parse({
      metadata: { name: "gate-first" },
      topology: "custom",
      budget: { max_tokens: 50 },
      nodes: {
        gated: { agent: "w", objective: "x", budget_tokens: 40, gate: { question: "ok?" } },
        after: { agent: "w", objective: "y", budget_tokens: 40 },
      },
    });
    const v = await runGraph(planGraph(graph), { cwd, runner, graph, interactive: hooks() });
    // gated auto-skips headless (no askGate) → its 40 never allocates → after fits under 50
    expect(v.nodes.find((n) => n.id === "gated")?.status).toBe("skipped");
    expect(v.nodes.find((n) => n.id === "after")?.status).toBe("ok");
    expect(v.stop_reason).toBeUndefined();
  });

  test("gk run start records budget; gk run status reports allocated/remaining/warn", () => {
    writeFileSync(
      join(cwd, "graph.yaml"),
      [
        "apiVersion: graphkit.dev/v2",
        "kind: Graph",
        "metadata:",
        "  name: budgeted",
        "topology: custom",
        "budget:",
        "  max_tokens: 100",
        "  warn_at: 0.5",
        "nodes:",
        "  first:",
        "    agent: w",
        "    objective: step one",
        "    budget_tokens: 60",
        "  second:",
        "    agent: w",
        "    objective: step two",
        "    depend_on: [first]",
        "    budget_tokens: 60",
      ].join("\n"),
    );
    const start = JSON.parse(runCli(["run", "start"], cwd).stdout);
    expect(start.status).toBe("ok");
    const meta = JSON.parse(readFileSync(join(start.data.dir, "meta.json"), "utf-8"));
    expect(meta.budget).toEqual({ max_tokens: 100, warn_at: 0.5 });

    const before = JSON.parse(runCli(["run", "status"], cwd).stdout);
    expect(before.data.budget).toMatchObject({
      max: 100,
      warn_at: 0.5,
      allocated: 0,
      remaining: 100,
      warn: false,
      exceeded: false,
      tripped_by: null,
    });

    // a dispatch intent charges the node's declared 60 → over warn_at 50%
    const disp = JSON.parse(runCli(["run", "dispatch", "first"], cwd).stdout);
    expect(disp.status).toBe("ok");
    const after = JSON.parse(runCli(["run", "status"], cwd).stdout);
    expect(after.data.budget).toMatchObject({ allocated: 60, remaining: 40, warn: true, exceeded: false });

    // dispatching the second declared 60 would push past the cap → refused
    const refused = JSON.parse(runCli(["run", "dispatch", "second"], cwd).stdout);
    expect(refused.status).toBe("fail");
    expect(refused.error.code).toBe("BUDGET_EXCEEDED");
    const over = JSON.parse(runCli(["run", "status"], cwd).stdout);
    expect(over.data.budget).toMatchObject({ allocated: 60, remaining: 40, warn: true, exceeded: false });
  });

  test("gk run status omits the budget block for graphs without one", () => {
    writeFileSync(
      join(cwd, "graph.yaml"),
      "apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: plain\ntopology: custom\nnodes:\n  a:\n    agent: w\n    objective: x\n",
    );
    expect(JSON.parse(runCli(["run", "start"], cwd).stdout).status).toBe("ok");
    const status = JSON.parse(runCli(["run", "status"], cwd).stdout);
    expect(status.data.budget).toBeUndefined();
  });

  test("node-agents: materialized brief carries the remaining-budget line", () => {
    mkdirSync(join(cwd, ".omp", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "agents", "worker.md"), "You are worker.\n");
    materializeNodeAgents(cwd, budgetGraph(100));
    const first = readFileSync(join(cwd, ".omp", "agents", "gk-first.md"), "utf-8");
    expect(first).toContain("Context budget remaining: 40 tokens");
    const second = readFileSync(join(cwd, ".omp", "agents", "gk-second.md"), "utf-8");
    expect(second).toContain("Context budget remaining: -20 tokens");
  });

  test("node-agents: no budget block on graphs without budget", () => {
    mkdirSync(join(cwd, ".omp", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "agents", "worker.md"), "You are worker.\n");
    const plain = GraphSchema.parse({
      metadata: { name: "plain" },
      topology: "custom",
      nodes: { a: { agent: "worker", objective: "x" } },
    });
    materializeNodeAgents(cwd, plain);
    expect(readFileSync(join(cwd, ".omp", "agents", "gk-a.md"), "utf-8")).not.toContain("Context budget");
  });
});
