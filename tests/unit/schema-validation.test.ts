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

describe("Graph YAML Schema — audit strictness fixes", () => {
  const base = { metadata: { name: "t" }, topology: "custom" as const, nodes: { a: { agent: "A", objective: "x" } } };

  test("metadata accepts unknown keys (passthrough)", () => {
    const result = GraphSchema.safeParse({ ...base, metadata: { name: "t", owner: "team-x", labels: { a: 1 } } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.metadata.owner).toBe("team-x");
  });

  test("input definitions accept unknown keys (passthrough)", () => {
    const result = GraphSchema.safeParse({
      ...base,
      inputs: { region: { type: "string", description: "aws region", required: true, ui_hint: "dropdown" } },
    });
    expect(result.success).toBe(true);
  });

  test("node ids reject path separators and traversal", () => {
    for (const id of ["bad/id", "..", "a b"]) {
      const result = GraphSchema.safeParse({ ...base, nodes: { [id]: { agent: "A", objective: "x" } } });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = JSON.stringify(result.error.issues);
        expect(messages).toContain(`"${id}"`);
        expect(messages).toContain("A-Za-z0-9");
      }
    }
  });

  test("node ids accept dots, dashes, underscores, and alphanumerics", () => {
    const nodes = Object.fromEntries(
      ["review.v2", "code-review", "fix_it", "Node9"].map((id) => [id, { agent: "A", objective: "x" }]),
    );
    expect(GraphSchema.safeParse({ ...base, nodes }).success).toBe(true);
  });

  test("tools_allowlist constraint accepts a list value", () => {
    const result = GraphSchema.safeParse({
      ...base,
      nodes: { a: { agent: "A", objective: "x", constraints: [{ tools_allowlist: ["Read", "Grep"] }] } },
    });
    expect(result.success).toBe(true);
  });
});
