import { describe, expect, test } from "bun:test";
import { MemoryConfig } from "../../src/schemas/memory.schema.js";

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
