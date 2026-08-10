import { describe, expect, test } from "bun:test";
import { GraphSchema } from "../../src/schemas/graph.schema";

describe("Graph YAML Schema", () => {
  test("accepts minimal valid graph", () => {
    const result = GraphSchema.safeParse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "test" },
      topology: "diamond",
      inputs: {},
      nodes: {
        worker: { agent: "Code Reviewer", objective: "review code" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid topology", () => {
    const result = GraphSchema.safeParse({
      metadata: { name: "test" },
      topology: "nonexistent",
    });
    expect(result.success).toBe(false);
  });

  test("rejects node with missing agent", () => {
    const result = GraphSchema.safeParse({
      metadata: { name: "test" },
      topology: "diamond",
      nodes: { worker: { objective: "review code" } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects cyclic depend_on", () => {
    const result = GraphSchema.safeParse({
      metadata: { name: "test" },
      topology: "diamond",
      nodes: {
        a: { agent: "A", depend_on: ["b"] },
        b: { agent: "B", depend_on: ["a"] },
      },
    });
    expect(result.success).toBe(false);
  });

  test("accepts all 6 topology names", () => {
    for (const topo of [
      "diamond",
      "classify-and-act",
      "adversarial-verification",
      "loop-until-done",
      "generate-and-filter",
      "tournament",
    ]) {
      const result = GraphSchema.safeParse({
        metadata: { name: "test" },
        topology: topo,
        nodes: {},
      });
      expect(result.success).toBe(true);
    }
  });

  test("validates loop config", () => {
    const result = GraphSchema.safeParse({
      metadata: { name: "test" },
      topology: "diamond",
      nodes: {
        scouter: {
          agent: "A",
          objective: "scout",
          loop: { enabled: true, max_rounds: 3, stop_when: "dry" },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
