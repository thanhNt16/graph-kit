import { describe, expect, test } from "bun:test";
import { applyRecallFilters, dropInvalid, type RecallEntry, resolveSuperseded } from "../../src/eval/memory-recall.js";

const NOW = "2026-08-15T00:00:00.000Z";

function e(partial: Partial<RecallEntry> & { id: string }): RecallEntry {
  return { file: `${partial.id}.md`, ...partial };
}

describe("dropInvalid (gk-recall step 4)", () => {
  test("drops expired, not-yet-valid, past-valid; keeps live", () => {
    const out = dropInvalid(
      [
        e({ id: "live" }),
        e({ id: "gone", expired: true }),
        e({ id: "future", valid_from: "2027-01-01T00:00:00.000Z" }),
        e({ id: "past", valid_to: "2026-01-01T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(out.map((x) => x.id)).toEqual(["live"]);
  });
});

describe("resolveSuperseded (gk-recall step 5)", () => {
  test("replaces head with present successor", () => {
    const out = resolveSuperseded([e({ id: "v1", superseded_by: "v2" }), e({ id: "v2" })]);
    expect(out.map((x) => x.id)).toEqual(["v2"]);
  });

  test("drops head whose successor is absent; follows chains", () => {
    const out = resolveSuperseded([
      e({ id: "a", superseded_by: "b" }),
      e({ id: "b", superseded_by: "c" }),
      e({ id: "c" }),
    ]);
    expect(out.map((x) => x.id)).toEqual(["c"]);
    expect(resolveSuperseded([e({ id: "orphan", superseded_by: "missing" })])).toEqual([]);
  });

  test("cycle cannot loop forever", () => {
    const out = resolveSuperseded([e({ id: "x", superseded_by: "y" }), e({ id: "y", superseded_by: "x" })]);
    expect(out).toEqual([]);
  });
});

describe("applyRecallFilters", () => {
  test("expired supersede head is gone even if ranker loved it", () => {
    const out = applyRecallFilters([e({ id: "old", expired: true, superseded_by: "new" }), e({ id: "new" })], NOW);
    expect(out.map((x) => x.id)).toEqual(["new"]);
  });
});
