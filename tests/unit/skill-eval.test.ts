import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { scoreWorkProduct } from "../../src/eval/rubrics.js";

describe("gk-eval gate behavior", () => {
  test("work_product: example-01 fixture yields MERGE", () => {
    const fixture = YAML.parse(
      readFileSync(join(import.meta.dir, "..", "..", "eval", "golden", "example-01-workproduct-merge.yaml"), "utf-8"),
    );
    const { verdict, scorecard } = scoreWorkProduct(
      { required_keys: fixture.input.required_keys },
      fixture.evidence,
      "strict",
    );
    expect(verdict).toBe("MERGE");
    expect(scorecard).toEqual({ findings: "ok", test_results: "ok" });
  });

  test("missing key → BLOCK", () => {
    const { verdict, scorecard } = scoreWorkProduct(
      { required_keys: ["findings", "missing"] },
      { findings: "SQL injection on line 42" },
      "strict",
    );
    expect(verdict).toBe("BLOCK");
    expect(scorecard.missing).toBe("missing");
  });
});