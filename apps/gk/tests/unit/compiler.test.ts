import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { compileGraph } from "../../src/compiler/emitter.js";
import type { Graph } from "../../src/compiler/validate.js";

const FIXTURES = join(import.meta.dir, "..", "..", "claude", "templates");
const TMP = join(import.meta.dir, ".tmp-compiler");

function tmpDir() {
  if (typeof rmSync !== "undefined") try { rmSync(TMP, { recursive: true }); } catch {}
  mkdirSync(TMP, { recursive: true });
  return TMP;
}

function makeGraph(topology: string, overrides?: Partial<Graph>): Graph {
  return GraphSchema.parse({
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "test-graph" },
    topology,
    inputs: {},
    nodes: {
      scouter: { agent: "Software Architect", model: "opus", objective: "analyze", tools: ["Read"], skills: [], refs: [], depend_on: [] },
      worker: { agent: "Code Reviewer", model: "sonnet", objective: "review", tools: ["Read"], depend_on: ["scouter"] },
      synthesizer: { agent: "Software Architect", model: "opus", objective: "synthesize", depend_on: ["worker"] },
    },
    ...overrides,
  }) as Graph;
}

describe("compileGraph", () => {
  test("diamond compiles to self-contained .workflow.js", () => {
    const graph = makeGraph("diamond");
    const output = compileGraph(graph, FIXTURES);
    expect(output).toContain("createDiamondWorkflow");
    expect(output).toContain("export default createDiamondWorkflow(graphConfig)");
    expect(output).toContain("export const meta");
    expect(output).toContain("graphConfig");
    // No imports from kit
    expect(output).not.toContain("from \"");
    expect(output).not.toContain("require(");
  });

  test("all 6 topologies compile", () => {
    const topologies = [
      "diamond", "classify-and-act", "adversarial-verification",
      "loop-until-done", "generate-and-filter", "tournament",
    ] as const;
    for (const topo of topologies) {
      const graph = makeGraph(topo);
      const output = compileGraph(graph, FIXTURES);
      expect(output, `${topo} should contain create fn`).toContain("export default");
      expect(output, `${topo} should contain meta`).toContain("export const meta");
    }
  });

  test("emitted config preserves model tiers", () => {
    const graph = makeGraph("diamond");
    const output = compileGraph(graph, FIXTURES);
    const parsed = JSON.parse(output.match(/const graphConfig = ({[\s\S]*?});/)?.[1] ?? "{}");
    expect(parsed.nodes.scouter.model).toBe("opus");
    expect(parsed.nodes.worker.model).toBe("sonnet");
  });

  test("unknown topology throws", () => {
    const graph = makeGraph("diamond");
    // Force bad topology by mutating after parse
    (graph as Record<string, unknown>).topology = "nonexistent";
    expect(() => compileGraph(graph, FIXTURES)).toThrow();
  });
});
