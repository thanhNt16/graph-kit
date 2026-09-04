import { describe, expect, test } from "bun:test";
import { PatternFileSchema, SuggestionFileSchema } from "../../src/schemas/memory.schema.js";

const BASE = {
  created_at: "2026-09-03T00:00:00.000Z",
  valid_from: "2026-09-03T00:00:00.000Z",
  salience: 3.5,
};

describe("pattern and suggestion frontmatter", () => {
  test("accepts a well-formed pattern", () => {
    const parsed = PatternFileSchema.safeParse({
      ...BASE,
      id: "pattern-1a2b3c4d",
      type: "pattern",
      kind: "node-sequence",
      label: "plan → build",
      members: ["plan", "build"],
      runs: ["r1", "r2", "r3"],
      count: 3,
      last_seen: "2026-09-02T00:00:00.000Z",
      signature: "1a2b3c4d",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects an unknown pattern kind", () => {
    const parsed = PatternFileSchema.safeParse({
      ...BASE,
      id: "p",
      type: "pattern",
      kind: "vibes",
      label: "x",
      members: [],
      runs: [],
      count: 1,
      last_seen: BASE.created_at,
      signature: "abcd1234",
    });
    expect(parsed.success).toBe(false);
  });

  test("accepts a suggestion and defaults status to proposed", () => {
    const parsed = SuggestionFileSchema.safeParse({
      ...BASE,
      id: "suggestion-1a2b3c4d",
      type: "suggestion",
      action: "materialize-template",
      rationale: "audit-pr ran 6 times",
      based_on: ["pattern-1a2b3c4d"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.status).toBe("proposed");
  });

  test("rejects an unknown suggestion action", () => {
    const parsed = SuggestionFileSchema.safeParse({
      ...BASE,
      id: "s",
      type: "suggestion",
      action: "do-magic",
      rationale: "x",
      based_on: [],
    });
    expect(parsed.success).toBe(false);
  });
});
