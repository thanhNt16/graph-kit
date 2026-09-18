// src/memory/suggest.ts
// Ranking + dismissal over suggestions/*.md. Consolidate owns creation and
// pruning; this module only reads and flips status — one writer per concern.
import { writeFileSync } from "node:fs";
import YAML from "yaml";
import { readMemoryFile, walkMemoryFiles } from "./store.js";

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
  const out: SuggestionEntry[] = [];
  for (const { path } of walkMemoryFiles(memDir).filter((f) => f.rel.startsWith("suggestions/"))) {
    const { fm, error } = readMemoryFile(path);
    if (error) continue; // unreadable/unparseable: skip, consolidate will prune it next pass
    out.push({
      id: String(fm.id ?? path.replace(/^.*\//, "").replace(/\.md$/, "")),
      file: path.replace(/^.*\//, ""),
      action: String(fm.action ?? ""),
      rationale: String(fm.rationale ?? ""),
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
  for (const { path } of walkMemoryFiles(memDir).filter((f) => f.rel.startsWith("suggestions/"))) {
    const { fm, body, error } = readMemoryFile(path);
    if (error) continue;
    const base = path.replace(/^.*\//, "").replace(/\.md$/, "");
    if (String(fm.id ?? "") !== id && base !== id) continue;
    fm.status = "dismissed";
    fm.dismissed_at = now;
    writeFileSync(path, `---\n${YAML.stringify(fm)}---\n${body}`);
    return true;
  }
  return false;
}
