// Runtime import, NOT `import type`: type-only imports are erased by the
// transpiler, so a missing src/exec/types.ts would silently pass. The
// side-effect import makes the seam a real module boundary — this test is
// red until the module exists.
import "../../src/exec/types.js";
import { describe, expect, test } from "bun:test";
import { planGraph } from "../../src/compiler/plan.js";
import type { PlannedNode } from "../../src/compiler/plan.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import type {
  DispatchContext,
  DispatchOutcome,
  InteractiveHooks,
  NodeRun,
  RunVerdict,
  Runner,
  WaveRun,
} from "../../src/exec/types.js";

// Task 1 contract: src/exec/types.ts is the engine's public IR. These tests
// drive the types the way Task 3's engine will — a stub Runner behind the
// seam (the engine never knows task-tool vs child-process), NodeRun/WaveRun
// flowing through hooks, and a RunVerdict assembling at exit. Status unions
// are tripwired with @ts-expect-error: inert under bun, fatal under tsc the
// day tests join the typecheck include.
function twoNodeGraph() {
  return GraphSchema.parse({
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "exec-types" },
    topology: "diamond",
    nodes: {
      scouter: { agent: "Software Architect", objective: "scout" },
      worker: { agent: "Code Reviewer", objective: "work", depend_on: ["scouter"] },
    },
  });
}

class RecordingRunner implements Runner {
  calls: Array<{ node: PlannedNode; ctx: DispatchContext }> = [];

  async dispatch(node: PlannedNode, ctx: DispatchContext): Promise<DispatchOutcome> {
    this.calls.push({ node, ctx });
    return { ok: true, output: `did ${node.id}`, exitCode: 0, durationMs: 5 };
  }
}

describe("exec types — Runner seam", () => {
  test("stub Runner records dispatches and returns a DispatchOutcome", async () => {
    const runner = new RecordingRunner();
    const plan = planGraph(twoNodeGraph());
    const [scouter] = plan.waves[0].nodes;

    const outcome = await runner.dispatch(scouter, {
      runId: "20261007-120000-exec-types",
      cwd: "/tmp/proj",
      node: scouter,
      attempt: 1,
      upstream: new Map(),
    });

    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0].node.id).toBe("scouter");
    expect(runner.calls[0].ctx.runId).toBe("20261007-120000-exec-types");
    expect(runner.calls[0].ctx.attempt).toBe(1);
    expect(outcome).toEqual({ ok: true, output: "did scouter", exitCode: 0, durationMs: 5 });
  });

  test("DispatchContext.upstream carries upstream NodeRuns to the dispatch", async () => {
    const runner = new RecordingRunner();
    const plan = planGraph(twoNodeGraph());
    const [scouter, worker] = plan.waves.flatMap((w) => w.nodes);
    const scouterRun: NodeRun = {
      id: "scouter",
      wave: 0,
      status: "ok",
      outcome: { ok: true, output: "did scouter", exitCode: 0, durationMs: 5 },
      attempts: 1,
    };

    await runner.dispatch(worker, {
      runId: "r1",
      cwd: "/tmp/proj",
      node: worker,
      attempt: 1,
      upstream: new Map([["scouter", scouterRun]]),
    });

    const ctx = runner.calls[0].ctx;
    expect(ctx.upstream.get("scouter")?.status).toBe("ok");
    expect(ctx.upstream.get("scouter")?.outcome?.output).toBe("did scouter");
  });
});

describe("exec types — run IR shapes", () => {
  test("NodeRun and WaveRun assemble across the full status union", () => {
    const outcome: DispatchOutcome = { ok: false, output: "boom", exitCode: 1, durationMs: 12, timedOut: true };
    const runs: NodeRun[] = [
      { id: "a", wave: 0, status: "ok", attempts: 1 },
      { id: "b", wave: 0, status: "fail", outcome, attempts: 3 },
      { id: "c", wave: 1, status: "skipped", attempts: 0 },
      { id: "d", wave: 1, status: "challenge", attempts: 1 },
      { id: "b", wave: 0, status: "landed", attempts: 3 },
    ];
    const wave: WaveRun = { index: 0, curator: false, nodes: runs.slice(0, 2) };

    expect(wave.nodes.map((n) => n.status)).toEqual(["ok", "fail"]);
    expect(runs[4].status).toBe("landed");
    // @ts-expect-error "bogus" is not a NodeRun status
    const bad: NodeRun["status"] = "bogus";
    expect(typeof bad).toBe("string");
  });

  test("RunVerdict assembles with the endRun status union", () => {
    const wave: WaveRun = { index: 0, curator: false, nodes: [] };
    const verdict: RunVerdict = {
      status: "merged",
      runId: "20261007-120000-exec-types",
      waves: [wave],
      nodes: [],
      unresolved: [],
    };
    expect(verdict.status).toBe("merged");
    // @ts-expect-error "aborted" is not a RunVerdict status
    const bad: RunVerdict["status"] = "aborted";
    expect(typeof bad).toBe("string");
  });
});

describe("exec types — InteractiveHooks", () => {
  test("required hooks fire; optional gate/challenge hooks may be absent", () => {
    const plan = planGraph(twoNodeGraph());
    const waves: number[] = [];
    const results: string[] = [];
    const hooks: InteractiveHooks = {
      onWaveStart: (w) => waves.push(w.index),
      onNodeResult: (n) => results.push(n.id),
    };

    hooks.onWaveStart(plan.waves[0]);
    hooks.onNodeResult({ id: "scouter", wave: 0, status: "ok", attempts: 1 });

    expect(waves).toEqual([0]);
    expect(results).toEqual(["scouter"]);
    expect(hooks.askGate).toBeUndefined();
    expect(hooks.askChallenge).toBeUndefined();
  });

  test("adjudication hooks resolve to the documented verdicts", async () => {
    const hooks: InteractiveHooks = {
      onWaveStart: () => {},
      onNodeResult: () => {},
      askGate: async () => true,
      askChallenge: async (finding) => (finding.includes("premise") ? "modify" : "reject"),
    };
    const node = planGraph(twoNodeGraph()).waves[0].nodes[0];
    // Engine invokes askGate only for nodes with a declared gate — the
    // parameter is NonNullable<PlannedNode["gate"]>.
    const gate = node.gate ?? { question: "proceed?" };

    await expect(hooks.askGate?.(node, gate)).resolves.toBe(true);
    await expect(hooks.askChallenge?.("CHALLENGE: scouter — premise wrong")).resolves.toBe("modify");
  });
});
