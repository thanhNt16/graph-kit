export type Tier = "opus" | "sonnet" | "haiku" | "fable";

export const CURSOR_MODEL_DEFAULTS: Record<Tier, string> = {
  opus: "Grok 4.5",
  sonnet: "Composer 2.5",
  haiku: "Auto",
  fable: "Auto",
};

export function resolveCursorModel(model: string | undefined, overrides: Record<string, string> = {}): string {
  if (!model) return "Auto";
  if (overrides[model]) return overrides[model];
  return CURSOR_MODEL_DEFAULTS[model as Tier] ?? "Auto";
}
