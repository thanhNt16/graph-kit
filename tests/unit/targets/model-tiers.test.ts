import { describe, expect, test } from "bun:test";
import { resolveModel, TARGET_MODEL_DEFAULTS } from "../../../src/targets/model-tiers.js";

describe("per-target model tiers", () => {
  test("pi and claude defaults cover four tiers", () => {
    for (const t of ["claude", "pi"]) {
      for (const tier of ["opus", "sonnet", "haiku", "fable"]) {
        expect(typeof TARGET_MODEL_DEFAULTS[t][tier]).toBe("string");
      }
    }
  });

  test("pi tiers are empty by design (pi resolves from its own models.json)", () => {
    expect(TARGET_MODEL_DEFAULTS.pi).toEqual({ opus: "", sonnet: "", haiku: "", fable: "" });
    // empty tier resolves to "" so callers emit no model field
    expect(resolveModel("pi", "opus")).toBe("");
  });

  test("known defaults", () => {
    expect(TARGET_MODEL_DEFAULTS.claude).toEqual({
      opus: "opus",
      sonnet: "sonnet",
      haiku: "haiku",
      fable: "fable",
    });
  });

  test("override wins over default", () => {
    expect(resolveModel("claude", "opus", { opus: "claude-opus-4-6" })).toBe("claude-opus-4-6");
  });

  test("unknown or missing model falls back to Auto", () => {
    expect(resolveModel("claude", undefined)).toBe("Auto");
    expect(resolveModel("claude", "gpt-4")).toBe("Auto");
  });

  test("dropped target ids fall back to Auto", () => {
    expect(resolveModel("cursor", "opus")).toBe("Auto");
    expect(resolveModel("codex", undefined)).toBe("Auto");
  });
});
