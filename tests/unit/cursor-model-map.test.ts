import { describe, expect, test } from "bun:test";
import { resolveModel, TARGET_MODEL_DEFAULTS } from "../../src/targets/model-tiers.js";

describe("cursor model map", () => {
  test("defaults map all four tiers", () => {
    expect(TARGET_MODEL_DEFAULTS.cursor.opus).toBe("Grok 4.5");
    expect(TARGET_MODEL_DEFAULTS.cursor.sonnet).toBe("Composer 2.5");
    expect(TARGET_MODEL_DEFAULTS.cursor.haiku).toBe("Auto");
    expect(TARGET_MODEL_DEFAULTS.cursor.fable).toBe("Auto");
  });

  test("resolve uses default when no override", () => {
    expect(resolveModel("cursor", "opus")).toBe("Grok 4.5");
    expect(resolveModel("cursor", "haiku")).toBe("Auto");
  });

  test("override wins over default", () => {
    expect(resolveModel("cursor", "sonnet", { sonnet: "Claude Sonnet 4.5" })).toBe("Claude Sonnet 4.5");
  });

  test("unknown or missing model falls back to Auto", () => {
    expect(resolveModel("cursor", undefined)).toBe("Auto");
    expect(resolveModel("cursor", "gpt-4")).toBe("Auto");
  });
});
