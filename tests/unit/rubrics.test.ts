import { describe, expect, test } from "bun:test";
import { scoreMemory, scoreWorkProduct } from "../../src/eval/rubrics.js";

describe("scoreWorkProduct", () => {
  test("MERGE when all required keys present and non-empty", () => {
    const r = scoreWorkProduct(
      { required_keys: ["findings", "test_results"] },
      { findings: "SQL injection on L42", test_results: "12 passing" },
      "strict",
    );
    expect(r.verdict).toBe("MERGE");
    expect(r.scorecard.findings).toBe("ok");
  });

  test("BLOCK when a required key is missing", () => {
    const r = scoreWorkProduct({ required_keys: ["findings", "test_results"] }, { findings: "x" }, "strict");
    expect(r.verdict).toBe("BLOCK");
    expect(r.scorecard.test_results).toBe("missing");
  });

  test("BLOCK when a required key is empty under strict", () => {
    const r = scoreWorkProduct({ required_keys: ["findings"] }, { findings: "   " }, "strict");
    expect(r.verdict).toBe("BLOCK");
  });
});

describe("scoreMemory — Letta 2x2 with abstention weighting", () => {
  test("penalizes confident-from-stale more than admitting ignorance", () => {
    const staleAnswered = scoreMemory(
      {
        adherence: 0.4,
        retrieval: 0.3,
        generalization: 0.5,
        hygiene: 0.5,
        staleAnsweredFrom: 3,
        admittedIgnorance: 0,
      },
      { abstention_weighted: true },
    );
    const admitted = scoreMemory(
      {
        adherence: 0.4,
        retrieval: 0.3,
        generalization: 0.5,
        hygiene: 0.5,
        staleAnsweredFrom: 0,
        admittedIgnorance: 3,
      },
      { abstention_weighted: true },
    );
    expect(admitted.overall).toBeGreaterThan(staleAnswered.overall);
  });

  test("abstention weighting off → equal scores", () => {
    const a = scoreMemory(
      {
        adherence: 0.5,
        retrieval: 0.5,
        generalization: 0.5,
        hygiene: 0.5,
        staleAnsweredFrom: 3,
        admittedIgnorance: 0,
      },
      { abstention_weighted: false },
    );
    expect(a.overall).toBeCloseTo(0.5, 2);
  });
});
