import type { Tier } from "./types.js";

export const TARGET_MODEL_DEFAULTS: Record<string, Record<Tier, string>> = {
  claude: { opus: "opus", sonnet: "sonnet", haiku: "haiku", fable: "fable" },
  cursor: { opus: "Grok 4.5", sonnet: "Composer 2.5", haiku: "Auto", fable: "Auto" },
  opencode: {
    opus: "anthropic/claude-opus-4.5",
    sonnet: "anthropic/claude-sonnet-4.5",
    haiku: "anthropic/claude-haiku-4.5",
    fable: "Auto",
  },
  codex: { opus: "gpt-5.4", sonnet: "gpt-5.3-codex-spark", haiku: "gpt-5.3-codex-spark", fable: "gpt-5.4" },
  pi: { opus: "", sonnet: "", haiku: "", fable: "" }, // empty → resolved from user's models.json by pi itself; emit no model field
};

export function resolveModel(targetId: string, model: string | undefined, overrides: Record<string, string> = {}): string {
  if (!model) return "Auto";
  if (overrides[model]) return overrides[model];
  const tiers = TARGET_MODEL_DEFAULTS[targetId];
  if (!tiers) return "Auto";
  const v = tiers[model as Tier];
  return v === "" ? "" : (v ?? "Auto");
}
