import { describe, expect, test } from "bun:test";
import { CURSOR_MODEL_DEFAULTS, resolveCursorModel } from "../../src/models/cursor-map.js";

describe("cursor model map", () => {
  test("defaults map all four tiers", () => {
    expect(CURSOR_MODEL_DEFAULTS.opus).toBe("Grok 4.5");
    expect(CURSOR_MODEL_DEFAULTS.sonnet).toBe("Composer 2.5");
    expect(CURSOR_MODEL_DEFAULTS.haiku).toBe("Auto");
    expect(CURSOR_MODEL_DEFAULTS.fable).toBe("Auto");
  });

  test("resolve uses default when no override", () => {
    expect(resolveCursorModel("opus")).toBe("Grok 4.5");
    expect(resolveCursorModel("haiku")).toBe("Auto");
  });

  test("override wins over default", () => {
    expect(resolveCursorModel("sonnet", { sonnet: "Claude Sonnet 4.5" })).toBe("Claude Sonnet 4.5");
  });

  test("unknown or missing model falls back to Auto", () => {
    expect(resolveCursorModel(undefined)).toBe("Auto");
    expect(resolveCursorModel("gpt-4")).toBe("Auto");
  });
});
