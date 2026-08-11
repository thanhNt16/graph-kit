import { describe, expect, test } from "bun:test";
import { actRScore, shouldExpire } from "../../src/eval/forgetting.js";

describe("actRScore", () => {
  const now = "2026-08-08T00:00:00Z";
  test("recent, relevant, well-connected → high score", () => {
    const s = actRScore({ relevance: 0.9, connectivity: 0.8, use_count: 5, last_used_at: "2026-08-07T00:00:00Z", now });
    expect(s).toBeGreaterThan(0.5);
  });
  test("stale and unused → low score", () => {
    const s = actRScore({ relevance: 0.5, connectivity: 0.2, use_count: 0, last_used_at: "2026-01-01T00:00:00Z", now });
    expect(s).toBeLessThan(0.3);
  });
  test("clamped to [0,1]", () => {
    const hi = actRScore({ relevance: 5, connectivity: 5, use_count: 100, last_used_at: now, now });
    expect(hi).toBeLessThanOrEqual(1);
  });
});

test("shouldExpire below threshold", () => {
  expect(shouldExpire(0.1, 0.3)).toBe(true);
  expect(shouldExpire(0.6, 0.3)).toBe(false);
});
