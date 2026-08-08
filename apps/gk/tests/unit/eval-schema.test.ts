import { describe, expect, test } from "bun:test";
import { EvalConfig } from "../../src/schemas/eval.schema.js";

describe("EvalConfig", () => {
  test("defaults to work_product / strict / abstention-weighted", () => {
    const e = EvalConfig.parse({});
    expect(e.mode).toBe("work_product");
    expect(e.rubric).toBe("strict");
    expect(e.abstention_weighted).toBe(true);
  });

  test("accepts memory + both modes", () => {
    expect(EvalConfig.parse({ mode: "memory" }).mode).toBe("memory");
    expect(EvalConfig.parse({ mode: "both" }).mode).toBe("both");
  });

  test("llm_as_judge defaults disabled", () => {
    expect(EvalConfig.parse({}).llm_as_judge).toBeUndefined();
    const e = EvalConfig.parse({ llm_as_judge: { enabled: true, refuters: ["Code Reviewer"] } });
    expect(e.llm_as_judge?.survive_threshold).toBe(2);
    expect(e.llm_as_judge?.refusers ?? e.llm_as_judge?.refuters).toEqual(["Code Reviewer"]);
  });
});
