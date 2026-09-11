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

// Round 4: unknown ≠ expiring. A garbage last_used_at used to map to
// ageDays=Infinity → decay 0 → score 0 → auto-expiry: silent, irreversible
// data loss from one loosely-written field.
describe("unknown-score contract (round 4)", () => {
  const now = "2026-08-08T00:00:00Z";
  test("unparseable last_used_at → actRScore null, not a 0 score", () => {
    // Note: engines leniently parse some non-ISO forms ("2026-1-5" → Jan 5 on
    // JSC/V8) — those get a real score, which is fine. The guard is for input
    // Date.parse genuinely rejects.
    for (const garbage of ["recently", "", "yesterday", "not a date", "2026-13-99"]) {
      expect(actRScore({ relevance: 0.9, connectivity: 1, use_count: 50, last_used_at: garbage, now })).toBeNull();
    }
  });
  test("non-finite relevance/connectivity/use_count → null (NaN can't reach shouldExpire)", () => {
    expect(actRScore({ relevance: Number.NaN, connectivity: 1, use_count: 1, last_used_at: now, now })).toBeNull();
    expect(actRScore({ relevance: 0.5, connectivity: Number.NaN, use_count: 1, last_used_at: now, now })).toBeNull();
    expect(actRScore({ relevance: 0.5, connectivity: 1, use_count: Number.NaN, last_used_at: now, now })).toBeNull();
    expect(
      actRScore({ relevance: Number.POSITIVE_INFINITY, connectivity: 1, use_count: 1, last_used_at: now, now }),
    ).toBeNull();
  });
  test("valid inputs still return a finite number", () => {
    const s = actRScore({ relevance: 0.9, connectivity: 0.8, use_count: 5, last_used_at: "2026-08-07T00:00:00Z", now });
    expect(typeof s).toBe("number");
    expect(Number.isFinite(s)).toBe(true);
  });
});
