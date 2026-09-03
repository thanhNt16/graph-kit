// src/memory/suggest.ts
// Ranking + dismissal over suggestions/*.md. Consolidate owns creation and
// pruning; this module only reads and flips status — one writer per concern.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export interface SuggestionEntry {
  id: string;
  file: string;
  action: string;
  rationale: string;
  based_on: string[];
  status: string;
  salience: number;
}

export function readSuggestions(memDir: string): SuggestionEntry[] {
  const dir = join(memDir, "suggestions");
  if (!existsSync(dir)) return [];
  const out: SuggestionEntry[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const raw = readFileSync(join(dir, f), "utf-8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    try {
      const fm = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
      out.push({
        id: String(fm.id ?? f.replace(/\.md$/, "")),
        file: f,
        action: String(fm.action ?? ""),
        rationale: String(fm.rationale ?? ""),
        based_on: Array.isArray(fm.based_on) ? fm.based_on.map(String) : [],
        status: String(fm.status ?? "proposed"),
        salience: typeof fm.salience === "number" ? fm.salience : 0,
      });
    } catch {
      // unparseable frontmatter: skip, consolidate will prune it next pass
    }
  }
  return out;
}

export function rankSuggestions(entries: SuggestionEntry[]): SuggestionEntry[] {
  const weight = (s: SuggestionEntry) => (s.status === "proposed" ? 1 : 0);
  return [...entries].sort((a, b) => weight(b) - weight(a) || b.salience - a.salience || a.id.localeCompare(b.id));
}

export function dismissSuggestion(memDir: string, id: string, now = new Date().toISOString()): boolean {
  const dir = join(memDir, "suggestions");
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const path = join(dir, f);
    const raw = readFileSync(path, "utf-8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
    if (String(fm.id ?? "") !== id && f.replace(/\.md$/, "") !== id) continue;
    fm.status = "dismissed";
    fm.dismissed_at = now;
    writeFileSync(path, `---\n${YAML.stringify(fm)}---\n${raw.slice(m[0].length)}`);
    return true;
  }
  return false;
}
