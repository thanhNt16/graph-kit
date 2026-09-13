// Round 5 B3: planExecutionWaves extracted from the CLI — cadence rules were
// only testable through `gk graph waves` before.
import { describe, expect, test } from "bun:test";
import YAML from "yaml";
import { planExecutionWaves } from "../../src/compiler/waves.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

function graph(yaml: string) {
  return GraphSchema.parse(YAML.parse(yaml));
}

describe("planExecutionWaves", () => {
  test("diamond: waves partition without curator metadata", () => {
    const g = graph(`apiVersion: graphkit.dev/v2
kind: Graph
metadata: { name: d }
topology: diamond
nodes:
  a: { agent: x, objective: o, depend_on: [] }
  b: { agent: y, objective: o, depend_on: [a] }
  c: { agent: y, objective: o, depend_on: [a] }
  d: { agent: z, objective: o, depend_on: [b, c] }
`);
    const { plan, unresolved } = planExecutionWaves(g);
    expect(unresolved).toEqual([]);
    expect(plan.total_waves).toBe(3);
    expect(plan.total_nodes).toBe(4);
    expect(plan.waves[0].nodes.map((n) => n.id)).toEqual(["a"]);
    expect(plan.waves[1].nodes.map((n) => n.id).sort()).toEqual(["b", "c"]);
    expect(plan.waves[1].parallel).toBe(true);
    expect(plan.memory).toBeUndefined();
  });

  test("memory-augmented on_node_complete: curator after every action wave + final", () => {
    const g = graph(`apiVersion: graphkit.dev/v2
kind: Graph
metadata: { name: m }
topology: memory-augmented
nodes:
  curator: { agent: c, objective: curate, depend_on: [] }
  a: { agent: x, objective: o, depend_on: [] }
  b: { agent: y, objective: o, depend_on: [a] }
topology_config:
  memory: { curator_node: curator }
evidence: { required_keys: [] }
`);
    const { plan } = planExecutionWaves(g);
    const kinds = plan.waves.map((w) => (w.curator ? "C" : "A"));
    expect(kinds).toEqual(["A", "C", "A", "C"]);
    expect(plan.memory).toMatchObject({ curator_node: "curator", cadence: "on_node_complete" });
    expect(plan.waves[1].nodes[0].skills).toContain("gk-recall");
  });

  test("memory-augmented every:2 fires at thresholds, plus the end-of-run crossing", () => {
    const mk = (n: number) => {
      const chain = Array.from({ length: n }, (_, i) => {
        const id = String.fromCharCode(97 + i); // a, b, c...
        const prev = i === 0 ? "" : `, depend_on: [${String.fromCharCode(96 + i)}]`;
        return `  ${id}: { agent: x, objective: o${prev} }`;
      }).join("\n");
      return graph(`apiVersion: graphkit.dev/v2
kind: Graph
metadata: { name: m }
topology: memory-augmented
nodes:
  curator: { agent: c, objective: curate, depend_on: [] }
${chain}
topology_config:
  memory: { curator_node: curator, cadence: every, every: 2 }
evidence: { required_keys: [] }
`);
    };
    // 3 chained actions: fire at the 2-crossing, then the 2→3 crossing fires the end-of-run pass
    const { plan } = planExecutionWaves(mk(3));
    expect(plan.waves.map((w) => (w.curator ? "C" : "A"))).toEqual(["A", "A", "C", "A", "C"]);

    // 4 chained actions: fires at 2 and 4; no end-of-run crossing (4 % 2 === 0)
    const { plan: p4 } = planExecutionWaves(mk(4));
    expect(p4.waves.map((w) => (w.curator ? "C" : "A"))).toEqual(["A", "A", "C", "A", "A", "C"]);
  });

  test("cycle surfaces as unresolved, not a partial plan", () => {
    // GraphSchema rejects cycles at parse time; planExecutionWaves is the layer
    // BELOW that gate, so feed it the raw shape directly.
    const g = {
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "cyc" },
      topology: "custom",
      nodes: {
        a: { agent: "x", objective: "o", depend_on: ["b"] },
        b: { agent: "y", objective: "o", depend_on: ["a"] },
      },
    } as unknown as Parameters<typeof planExecutionWaves>[0];
    const { unresolved } = planExecutionWaves(g);
    expect(unresolved.sort()).toEqual(["a", "b"]);
  });

  test("worst-case dispatch math: loop rounds and advisor caps ride the node payload", () => {
    const g = graph(`apiVersion: graphkit.dev/v2
kind: Graph
metadata: { name: w }
topology: custom
nodes:
  t: { agent: w, objective: briefs, depend_on: [] }
  a:
    agent: x
    objective: o
    depend_on: [t]
    loop: { enabled: true, max_rounds: 3 }
    advisor: { model: fable, after_failed_rounds: 1, max_calls: 2 }
    fan_out: { briefs_from: t, template: x }
`);
    const { plan } = planExecutionWaves(g);
    expect(plan.total_waves).toBe(2);
    const a = plan.waves[1].nodes[0];
    expect(a.loop).toMatchObject({ max_rounds: 3 });
    expect(a.advisor).toMatchObject({ max_calls: 2 });
    expect(a.fan_out).toMatchObject({ briefs_from: "t" });
  });
});
