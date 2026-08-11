import { describe, expect, test } from "bun:test";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import type { Graph } from "../../src/viewer/normalize.js";
import { computeLevels, MAX_NODES, normalizeGraph } from "../../src/viewer/normalize.js";

/** Parse + schema-validate YAML into a typed Graph. */
function parseGraph(doc: Record<string, unknown>): Graph {
  const parsed = GraphSchema.safeParse(doc);
  if (!parsed.success) throw new Error(`fixture failed schema: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data as Graph;
}

const diamond = () =>
  parseGraph({
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "diamond", description: "fan out/in" },
    topology: "diamond",
    inputs: { task: { type: "string", required: true } },
    nodes: {
      root: { agent: "software-architect", model: "opus", objective: "plan", depend_on: [], evidence: ["plan"] },
      a: { agent: "code-reviewer", model: "sonnet", objective: "do a", depend_on: ["root"], evidence: ["a"] },
      b: { agent: "data-engineer", model: "haiku", objective: "do b", depend_on: ["root"], evidence: ["b"] },
      leaf: { agent: "qa-engineer", model: "fable", objective: "merge", depend_on: ["a", "b"], evidence: ["leaf"] },
    },
    evidence: { required_keys: ["leaf"] },
  });

describe("normalizeGraph", () => {
  test("normalizes every supported node field", () => {
    const g = diamond();
    const res = normalizeGraph(g);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const n = res.graph.nodes.root;
    expect(n.id).toBe("root");
    expect(n.agent).toBe("software-architect");
    expect(n.model).toBe("opus");
    expect(n.objective).toBe("plan");
    expect(n.tools).toEqual([]);
    expect(n.skills).toEqual([]);
    expect(n.refs).toEqual([]);
    expect(n.constraints).toEqual([]);
    expect(n.loop).toBeNull();
    expect(n.evidence).toEqual(["plan"]);
    expect(n.depend_on).toEqual([]);
    expect(n.dependents).toEqual(["a", "b"]);
    expect(n.level).toBe(0);
    expect(n.order).toBe(0);
  });

  test("models default to sonnet; loop disabled becomes null", () => {
    const g = parseGraph({
      metadata: { name: "x" },
      topology: "custom",
      nodes: {
        n1: { agent: "code-reviewer", objective: "o" },
        n2: { agent: "code-reviewer", objective: "o", loop: { enabled: false, max_rounds: 3 } },
      },
    });
    const res = normalizeGraph(g);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.graph.nodes.n1.model).toBe("sonnet");
    expect(res.graph.nodes.n2.loop).toBeNull();
  });

  test("loop config is carried through when enabled", () => {
    const g = parseGraph({
      metadata: { name: "x" },
      topology: "custom",
      nodes: {
        n1: {
          agent: "code-reviewer",
          objective: "o",
          loop: { enabled: true, stop_when: "done", max_rounds: 7, exit_condition: "metric passes" },
        },
      },
    });
    const res = normalizeGraph(g);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.graph.nodes.n1.loop).toEqual({
      enabled: true,
      stop_when: "done",
      max_rounds: 7,
      exit_condition: "metric passes",
    });
  });

  test("refs, constraints, tools, skills, role, eval are preserved", () => {
    const g = parseGraph({
      metadata: { name: "x" },
      topology: "custom",
      nodes: {
        n1: {
          agent: "code-reviewer",
          role: "eval-gate",
          objective: "o",
          tools: ["Read", "Bash"],
          skills: ["gk-recall"],
          refs: [{ path: "docs/a.md", purpose: "context" }],
          constraints: [{ max_files: 50 }, { no_write: true }],
          eval: { mode: "work_product", rubric: "strict" },
        },
      },
    });
    const res = normalizeGraph(g);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const n = res.graph.nodes.n1;
    expect(n.role).toBe("eval-gate");
    expect(n.tools).toEqual(["Read", "Bash"]);
    expect(n.skills).toEqual(["gk-recall"]);
    expect(n.refs).toEqual([{ path: "docs/a.md", purpose: "context" }]);
    expect(n.constraints).toEqual([{ max_files: 50 }, { no_write: true }]);
    expect(n.eval?.mode).toBe("work_product");
  });

  test("forward and reverse edges are computed correctly", () => {
    const g = diamond();
    const res = normalizeGraph(g);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const graph = res.graph;
    expect(graph.nodeCount).toBe(4);
    expect(graph.edgeCount).toBe(4);
    expect(graph.nodes.root.dependents.sort()).toEqual(["a", "b"]);
    expect(graph.nodes.a.depend_on).toEqual(["root"]);
    expect(graph.nodes.a.dependents).toEqual(["leaf"]);
    expect(graph.nodes.leaf.depend_on.sort()).toEqual(["a", "b"]);
    expect(graph.nodes.leaf.dependents).toEqual([]);
  });

  test("deterministic topological levels", () => {
    const g = diamond();
    const res = normalizeGraph(g);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const graph = res.graph;
    expect(graph.nodes.root.level).toBe(0);
    expect(graph.nodes.a.level).toBe(1);
    expect(graph.nodes.b.level).toBe(1);
    expect(graph.nodes.leaf.level).toBe(2);
  });

  test("order is stable insertion order within each level", () => {
    const g = diamond();
    const res = normalizeGraph(g);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const graph = res.graph;
    expect(graph.nodes.a.order).toBe(0);
    expect(graph.nodes.b.order).toBe(1);
  });

  test("normalization is deterministic", () => {
    const res1 = normalizeGraph(diamond());
    const res2 = normalizeGraph(diamond());
    expect(res1.ok && res2.ok).toBe(true);
    if (!(res1.ok && res2.ok)) return;
    expect(res1.graph).toEqual(res2.graph);
  });

  test("rejects graphs above the 250-node ceiling", () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 0; i < MAX_NODES + 1; i++) {
      nodes[`n${i}`] = { agent: "code-reviewer", objective: "o" };
    }
    const g = parseGraph({ metadata: { name: "big" }, topology: "custom", nodes });
    const res = normalizeGraph(g);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("TOO_LARGE");
    expect(res.message).toContain(String(MAX_NODES));
  });

  test("graph metadata is carried to the view model", () => {
    const res = normalizeGraph(diamond());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.graph.name).toBe("diamond");
    expect(res.graph.description).toBe("fan out/in");
    expect(res.graph.topology).toBe("diamond");
  });
});

describe("computeLevels", () => {
  test("longest-path levels for a diamond", () => {
    const levels = computeLevels({
      root: { depend_on: [] },
      a: { depend_on: ["root"] },
      b: { depend_on: ["root"] },
      leaf: { depend_on: ["a", "b"] },
    });
    expect(levels.get("root")).toBe(0);
    expect(levels.get("a")).toBe(1);
    expect(levels.get("b")).toBe(1);
    expect(levels.get("leaf")).toBe(2);
  });

  test("cycle guard returns a level without hanging", () => {
    const levels = computeLevels({
      a: { depend_on: ["b"] },
      b: { depend_on: ["a"] },
    });
    expect(levels.has("a")).toBe(true);
    expect(levels.has("b")).toBe(true);
  });
});
