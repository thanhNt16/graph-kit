import { describe, expect, test } from "bun:test";
import { MemoryConfig, MemoryFileSchema } from "../../src/schemas/memory.schema.js";

describe("MemoryConfig", () => {
  test("applies defaults", () => {
    const c = MemoryConfig.parse({});
    expect(c.project).toBe("graph-kit-memory");
    expect(c.cadence).toBe("on_node_complete");
    expect(c.recall_topk).toBe(5);
    expect(c.expire_policy).toBe("act_r");
    expect(c.null_intervention_allowed).toBe(true);
  });

  test("cadence every requires every", () => {
    const c = MemoryConfig.parse({ cadence: "every", every: 3 });
    expect(c.every).toBe(3);
  });

  test("rejects unknown cadence", () => {
    expect(() => MemoryConfig.parse({ cadence: "sometimes" })).toThrow();
  });

  test("rejects every < 1", () => {
    expect(() => MemoryConfig.parse({ cadence: "every", every: 0 })).toThrow();
  });
});

describe("MemoryFileSchema (exec-tests step 1)", () => {
  test("accepts the legacy store shape (old fields optional, no additive fields needed)", () => {
    const r = MemoryFileSchema.safeParse({
      id: "routing-v1",
      type: "knowledge",
      source: ".graphkit/evidence/a.md",
      created_at: "2026-08-14T00:00:00.000Z",
      valid_from: "2026-08-14T00:00:00.000Z",
      salience: 0.5,
      expired: false,
      tags: ["routing"],
    });
    expect(r.success).toBe(true);
  });

  test("accepts the new additive provenance fields", () => {
    const r = MemoryFileSchema.safeParse({
      id: "m",
      type: "knowledge",
      generated: { by: "process:memory-persist", at: "2026-08-22T00:00:00.000Z" },
      recorded_at: "2026-08-22T00:00:00.000Z",
      status: "stable",
      sources: [{ resource: ".graphkit/evidence/reviewer.md" }],
    });
    expect(r.success).toBe(true);
  });

  test("rejects empty or missing identity", () => {
    expect(() => MemoryFileSchema.parse({ type: "knowledge" })).toThrow();
    expect(() => MemoryFileSchema.parse({ id: "", type: "knowledge" })).toThrow();
    expect(() => MemoryFileSchema.parse({ id: "x", type: "" })).toThrow();
  });

  test("rejects non-ISO dates", () => {
    expect(() => MemoryFileSchema.parse({ id: "x", type: "k", valid_from: "not-a-date" })).toThrow();
    expect(() => MemoryFileSchema.parse({ id: "x", type: "k", recorded_at: "2026/08/22" })).toThrow();
  });

  test("rejects invalid status and malformed sources entries", () => {
    expect(() => MemoryFileSchema.parse({ id: "x", type: "k", status: "archived" })).toThrow();
    expect(() => MemoryFileSchema.parse({ id: "x", type: "k", sources: [{}] })).toThrow();
  });

  test("preserves unknown frontmatter keys (passthrough survives rewrites)", () => {
    const parsed = MemoryFileSchema.parse({
      id: "x",
      type: "k",
      ponytail_note: "custom field a user added",
      use_count: 3,
    });
    expect(parsed.ponytail_note).toBe("custom field a user added");
    expect(parsed.use_count).toBe(3);
  });

  test("status enum is draft|stable|deprecated; absent means stable by convention", () => {
    const absent = MemoryFileSchema.parse({ id: "x", type: "k" });
    expect(absent.status).toBeUndefined(); // absent = stable
    for (const s of ["draft", "stable", "deprecated"]) {
      expect(MemoryFileSchema.safeParse({ id: "x", type: "k", status: s }).success).toBe(true);
    }
  });
});
