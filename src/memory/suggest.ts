// src/memory/suggest.ts
// Ranking + dismissal over suggestions/*.md. Consolidate owns creation and
// pruning; this module only reads and flips status — one writer per concern.
import { join } from "node:path";
import YAML from "yaml";
import { atomicWrite } from "../fs.js";
import { SuggestionFileSchema } from "../schemas/memory.schema.js";
import { walkMemoryStore } from "./frontmatter.js";

export interface SuggestionEntry {
  id: string;
  file: string;
  action: string;
  rationale: string;
  based_on: string[];
  status: string;
  salience: number;
}

// Suggestions carry status: proposed|accepted|dismissed — outside
// MemoryFileSchema's status enum — so they validate against their own schema.
const SUGGESTION_WALK = { schema: SuggestionFileSchema };

export function readSuggestions(memDir: string): SuggestionEntry[] {
  const out: SuggestionEntry[] = [];
  for (const entry of walkMemoryStore(join(memDir, "suggestions"), SUGGESTION_WALK)) {
    const fm = entry.fm;
    out.push({
      id: entry.id,
      file: entry.file,
      action: String(fm.action),
      rationale: String(fm.rationale),
      based_on: Array.isArray(fm.based_on) ? fm.based_on.map(String) : [],
      status: String(fm.status ?? "proposed"),
      salience: typeof fm.salience === "number" ? fm.salience : 0,
    });
  }
  return out;
}

export function rankSuggestions(entries: SuggestionEntry[]): SuggestionEntry[] {
  const weight = (s: SuggestionEntry) => (s.status === "proposed" ? 1 : 0);
  return [...entries].sort((a, b) => weight(b) - weight(a) || b.salience - a.salience || a.id.localeCompare(b.id));
}

export function dismissSuggestion(memDir: string, id: string, now = new Date().toISOString()): boolean {
  for (const entry of walkMemoryStore(join(memDir, "suggestions"), SUGGESTION_WALK)) {
    if (entry.id !== id) continue;
    const fm = entry.fm as typeof entry.fm & { dismissed_at?: string };
    fm.status = "dismissed";
    fm.dismissed_at = now;
    // F6: a human's dismissal rewrite is atomic — recall reads these files.
    atomicWrite(entry.path, `---\n${YAML.stringify(fm)}---\n${entry.body}`);
    return true;
  }
  return false;
}
