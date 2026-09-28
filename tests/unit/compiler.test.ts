import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { compileGraph } from "../../src/compiler/emitter.js";
import { type Graph, GraphSchema } from "../../src/schemas/graph.schema.js";

const FIXTURES = join(import.meta.dir, "..", "..", "kits", "claude", "templates");
const YAML_FIXTURES = join(import.meta.dir, "..", "fixtures");
const TMP = join(import.meta.dir, ".tmp-compiler");

function _tmpDir() {
  if (typeof rmSync !== "undefined")
    try {
      rmSync(TMP, { recursive: true });
    } catch {}
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
      scouter: {
        agent: "Software Architect",
        model: "opus",
        objective: "analyze",
        tools: ["Read"],
        skills: [],
        refs: [],
        depend_on: [],
      },
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
    expect(output).toContain("const _wf = createDiamondWorkflow(graphConfig)");
    expect(output).toContain("return await _wf(_ctx)");
    expect(output).toContain("export const meta");
    expect(output).toContain("graphConfig");
    // No imports from kit
    expect(output).not.toContain('from "');
    expect(output).not.toContain("require(");
    // Only one export (meta) — Workflow tool doesn't allow multiple
    expect(output.match(/^export /gm)?.length).toBe(1);
  });

  test("all 6 topologies compile", () => {
    const topologies = [
      "diamond",
      "classify-and-act",
      "adversarial-verification",
      "loop-until-done",
      "generate-and-filter",
      "tournament",
    ] as const;
    for (const topo of topologies) {
      const graph = makeGraph(topo);
      const output = compileGraph(graph, FIXTURES);
      expect(output, `${topo} should contain create fn`).toContain("_wf");
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

  test("compiles memory-augmented wrapping diamond", () => {
    const raw = readFileSync(join(YAML_FIXTURES, "memory-diamond.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    const script = compileGraph(graph, FIXTURES);
    expect(script).toContain("createMemoryAugmentedWorkflow");
    expect(script).toContain("createDiamondWorkflow"); // inner inlined
    expect(script).toContain('"__subgraph": "diamond"');
  });

  test("custom topology compiles to createCustomWorkflow", () => {
    const graph = makeGraph("custom");
    const output = compileGraph(graph, FIXTURES);
    expect(output).toContain("createCustomWorkflow");
    expect(output).toContain("const _wf = createCustomWorkflow(graphConfig)");
    expect(output).toContain("return await _wf(_ctx)");
    expect(output).toContain("export const meta");
  });

  test("flow presets map to createCustomWorkflow", () => {
    const presets = ["sdd", "superpowers", "research-and-build"] as const;
    for (const preset of presets) {
      const graph = makeGraph(preset);
      const output = compileGraph(graph, FIXTURES);
      expect(output, `${preset} should use createCustomWorkflow`).toContain("createCustomWorkflow");
      expect(output, `${preset} should have execution shim`).toContain("return await _wf(_ctx)");
    }
  });
});

describe("GraphSchema strictness", () => {
  const base = () => ({
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "strict-test" },
    topology: "diamond",
    nodes: {
      a: { agent: "x", objective: "do", depend_on: [], evidence: ["out"] },
    },
  });

  test("top-level `limits` is rejected (field was removed)", () => {
    const r = GraphSchema.safeParse({ ...base(), limits: { max_workers: 4 } });
    expect(r.success).toBe(false);
  });

  test("node `loop.exit_condition` is rejected (renamed stop_when)", () => {
    const g = base() as Record<string, any>;
    g.nodes.a.loop = { enabled: true, exit_condition: "done" };
    const r = GraphSchema.safeParse(g);
    expect(r.success).toBe(false);
  });

  test("node `loop.stop_when` + `max_rounds` still parse", () => {
    const g = base() as Record<string, any>;
    g.nodes.a.loop = { enabled: true, stop_when: "done", max_rounds: 5 };
    const r = GraphSchema.safeParse(g);
    expect(r.success).toBe(true);
  });

  test("unknown node field is rejected", () => {
    const g = base() as Record<string, any>;
    g.nodes.a.bogus_field = 1;
    expect(GraphSchema.safeParse(g).success).toBe(false);
  });

  // metadata is intentionally loose (passthrough) after the audit — the
  // positive contract is pinned in schema-validation.test.ts
  // ("metadata accepts unknown keys"); the old rejection pin is obsolete.
});
