import { describe, expect, test } from "bun:test";
import { validateGraph } from "../../src/compiler/validate.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

// Empty project root: agent-binding checks fire, but loop rules are what we assert.
const ROOT = "/tmp/no-agent-directory";

function graph(overrides: Record<string, unknown> = {}) {
  return GraphSchema.parse({
    metadata: { name: "loop-validation" },
    topology: "custom",
    nodes: { a: { agent: "coder", objective: "code", depend_on: [] } },
    ...overrides,
  });
}

describe("Loop Group Validation", () => {
  test("loop_node_exists: rejects non-existent node in loop", () => {
    const g = graph({
      nodes: { a: { agent: "coder", objective: "code", depend_on: [] } },
      loops: [{ nodes: ["a", "missing"], max_rounds: 3, stop_when: "ok" }],
    });
    const findings = validateGraph(g, ROOT);
    expect(findings).toContainEqual(
      expect.objectContaining({ check: "loop_node_exists", path: "loops[0].nodes" }),
    );
  });

  test("loop_no_overlap: rejects node in more than one loop group", () => {
    const g = graph({
      nodes: {
        a: { agent: "coder", objective: "code", depend_on: [] },
        b: { agent: "tester", objective: "test", depend_on: [] },
      },
      loops: [
        { nodes: ["a", "b"], max_rounds: 3, stop_when: "ok" },
        { nodes: ["b"], max_rounds: 2, stop_when: "ok" },
      ],
    });
    const findings = validateGraph(g, ROOT);
    expect(findings).toContainEqual(
      expect.objectContaining({ check: "loop_no_overlap", path: "loops[1].nodes" }),
    );
  });

  test("loop_gate_evidence_declared: rejects gate_evidence key not produced by any loop node", () => {
    const g = graph({
      nodes: { a: { agent: "coder", objective: "code", depend_on: [], evidence: ["real"] } },
      loops: [{ nodes: ["a"], max_rounds: 3, gate_evidence: ["non-existent-key"] }],
    });
    const findings = validateGraph(g, ROOT);
    expect(findings).toContainEqual(
      expect.objectContaining({ check: "loop_gate_evidence_declared", path: "loops[0].gate_evidence" }),
    );
  });

  test("loop_contiguous: rejects dependency between loop nodes through an intermediate non-loop node", () => {
    const g = graph({
      nodes: {
        a: { agent: "coder", objective: "code", depend_on: ["via"] },
        via: { agent: "coder", objective: "pipe", depend_on: ["b"] },
        b: { agent: "tester", objective: "test", depend_on: [] },
      },
      loops: [{ nodes: ["a", "b"], max_rounds: 3, stop_when: "ok" }],
    });
    const findings = validateGraph(g, ROOT);
    expect(findings).toContainEqual(
      expect.objectContaining({ check: "loop_contiguous", path: "loops[0].nodes" }),
    );
  });

  test("valid loop group produces zero loop findings", () => {
    const g = graph({
      nodes: {
        a: { agent: "coder", objective: "code", depend_on: ["b"], evidence: ["ok"] },
        b: { agent: "tester", objective: "test", depend_on: [], evidence: ["ok"] },
      },
      loops: [
        {
          nodes: ["a", "b"],
          max_rounds: 3,
          gate_evidence: ["ok"],
          stop_when: "ok",
        },
      ],
    });
    const findings = validateGraph(g, ROOT);
    expect(findings.filter((f) => f.check.startsWith("loop_"))).toEqual([]);
  });

  test("loop_contiguous: rejects non-loop sibling at wave 1 depended on by wave 2 loop node", () => {
    const g = graph({
      nodes: {
        src: { agent: "coder", objective: "seed", depend_on: [] },
        a: { agent: "coder", objective: "code", depend_on: ["src"] },
        c: { agent: "coder", objective: "pipe", depend_on: ["src"] },
        b: { agent: "tester", objective: "test", depend_on: ["c"] },
      },
      loops: [{ nodes: ["a", "b"], max_rounds: 3, stop_when: "ok" }],
    });
    const findings = validateGraph(g, ROOT);
    expect(findings).toContainEqual(
      expect.objectContaining({ check: "loop_contiguous", path: "loops[0].nodes" }),
    );
  });
});