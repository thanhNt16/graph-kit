import { TARGET_MODEL_DEFAULTS, resolveModel } from "../targets/model-tiers.js";

export type Tier = "opus" | "sonnet" | "haiku" | "fable";

export const CURSOR_MODEL_DEFAULTS: Record<Tier, string> = TARGET_MODEL_DEFAULTS.cursor;

export function resolveCursorModel(model: string | undefined, overrides: Record<string, string> = {}): string {
  return resolveModel("cursor", model, overrides);
}
