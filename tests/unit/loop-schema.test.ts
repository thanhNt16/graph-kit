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
      expect(parsed.data.loops?.[0].stop_when).toBe("tests pass");
      expect(parsed.data.loops?.[0].gate_evidence).toBeUndefined();
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
    if (parsed.success) {
      expect(parsed.data.loops?.[0].nodes).toEqual(["a"]);
      expect(parsed.data.loops?.[0].max_rounds).toBe(5);
      expect(parsed.data.loops?.[0].gate_evidence).toEqual(["test-report"]);
      expect(parsed.data.loops?.[0].stop_when).toBeUndefined();
    }
  });

  it("fails parsing when neither stop_when nor gate_evidence is provided", () => {
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
          max_rounds: 3,
        },
      ],
    };
    const parsed = GraphSchema.safeParse(doc);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => i.message);
      expect(
        messages.some((msg) =>
          msg.includes("At least one of stop_when or gate_evidence must be provided")
        )
      ).toBe(true);
    }
  });
});
