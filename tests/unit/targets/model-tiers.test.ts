import { describe, expect, test } from "bun:test";
import { resolveModel, TARGET_MODEL_DEFAULTS } from "../../../src/targets/model-tiers.js";

describe("per-target model tiers", () => {
  test("defaults for all five targets cover four tiers", () => {
    for (const t of ["claude", "cursor", "opencode", "codex", "pi"]) {
      for (const tier of ["opus", "sonnet", "haiku", "fable"]) {
        expect(typeof TARGET_MODEL_DEFAULTS[t][tier]).toBe("string");
      }
    }
  });

  test("known defaults", () => {
    expect(TARGET_MODEL_DEFAULTS.cursor.opus).toBe("Grok 4.5"); // regression guard
    expect(TARGET_MODEL_DEFAULTS.opencode.opus).toBe("anthropic/claude-opus-4.5");
    expect(TARGET_MODEL_DEFAULTS.codex.opus).toBe("gpt-5.4");
    expect(TARGET_MODEL_DEFAULTS.codex.sonnet).toBe("gpt-5.3-codex-spark");
  });

  test("override wins over default", () => {
    expect(resolveModel("codex", "opus", { opus: "gpt-5.5" })).toBe("gpt-5.5");
  });

  test("unknown or missing model falls back to Auto", () => {
    expect(resolveModel("codex", undefined)).toBe("Auto");
    expect(resolveModel("codex", "gpt-4")).toBe("Auto");
  });
});
