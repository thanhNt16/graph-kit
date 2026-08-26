import { describe, expect, it } from "bun:test";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

describe("LoopGroupSchema", () => {
  it("parses valid loop group with stop_when", () => {
    const doc = {
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "test" },
      topology: "custom",
      nodes: {
        a: { agent: "coder", objective: "code" },
        b: { agent: "tester", objective: "test", depend_on: ["a"] },
      },
      loops: [
        {
          nodes: ["a", "b"],
          max_rounds: 3,
          stop_when: "tests pass",
        },
      ],
    };
    const parsed = GraphSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.loops?.[0].nodes).toEqual(["a", "b"]);
      expect(parsed.data.loops?.[0].max_rounds).toBe(3);
    }
  });

  it("parses loop group with gate_evidence", () => {
    const doc = {
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "test" },
      topology: "custom",
      nodes: {
        a: { agent: "coder", objective: "code" },
      },
      loops: [
        {
          nodes: ["a"],
          max_rounds: 5,
          gate_evidence: ["test-report"],
        },
      ],
    };
    const parsed = GraphSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
  });
});
