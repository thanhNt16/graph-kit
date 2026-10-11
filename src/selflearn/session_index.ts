// IDX — the self-injected recall surface: a grouped index (category → name:
// ≤60-char description) of skills gk selflearn produced, injected at
// session-start so "whether the library is offered" is our own config, not
// host recall behavior. Port of autoharness hook/on_session_start.py (MIT).

import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { frontmatter, INDEX_DESC_MAX_CHARS } from "./lint.js";
import { lastRunPath, type SelflearnTarget, SKILL_FILE, SKILLS_MARKER, skillsDirFor } from "./state.js";

const INDEX_HEADER =
  "## Learned patterns\n\nSelf-learned skills (gk selflearn-managed). When the task at hand matches a description below, you MUST consider loading that skill before proceeding.";

const sanitize = (text: string, limit: number) => String(text).replace(/\s+/g, " ").trim().slice(0, limit);
const fit = (text: string, limit: number) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`;
};

export interface IndexedSkill {
  name: string;
  description: string;
  category: string;
}

/** Self-authored skills only — the marker sidecar is the membership key
 *  (kit-native / user skills stay out of the pool: zero intrusion). */
export function learnedSkills(cwd: string, target: SelflearnTarget): IndexedSkill[] {
  const dir = skillsDirFor(cwd, target);
  if (!existsSync(dir)) return [];
  const out: IndexedSkill[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const marker = join(dir, e.name, SKILLS_MARKER);
    const file = join(dir, e.name, SKILL_FILE);
    if (!existsSync(marker) || !existsSync(file)) continue;
    const fm = frontmatter(readFileSync(file, "utf-8")) ?? {};
    out.push({
      name: e.name,
      description: fm.description || "(no description)",
      category: fm.category || "general",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The grouped index text, or null when the library is empty (zero injection). */
export function skillIndex(cwd: string, target: SelflearnTarget): string | null {
  const groups = new Map<string, string[]>();
  for (const s of learnedSkills(cwd, target)) {
    const cat = sanitize(s.category, 64) || "general";
    const line = `- ${sanitize(s.name, 64)}: ${fit(s.description, INDEX_DESC_MAX_CHARS)}`;
    groups.set(cat, [...(groups.get(cat) ?? []), line]);
  }
  if (!groups.size) return null;
  const lines = [INDEX_HEADER, ""];
  for (const cat of [...groups.keys()].sort()) {
    lines.push(`### ${cat}`, ...(groups.get(cat) ?? []));
  }
  return lines.join("\n");
}

/** Full description index of ALL skills in the tree (learned + kit-native),
 *  for the reflector's compare-first dedupe pass. */
export function descriptionIndex(cwd: string, target: SelflearnTarget): string {
  const dir = skillsDirFor(cwd, target);
  if (!existsSync(dir)) return "(no live skills yet)";
  const lines: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const file = join(dir, e.name, SKILL_FILE);
    if (!existsSync(file)) continue;
    const fm = frontmatter(readFileSync(file, "utf-8")) ?? {};
    const tag = existsSync(join(dir, e.name, SKILLS_MARKER)) ? "learned" : "kit";
    lines.push(`- ${fm.name || e.name} [${tag}]: ${fm.description || "(no description)"}`);
  }
  return lines.length ? lines.join("\n") : "(no live skills yet)";
}

/** One-line anti-silence digest of the previous drain — consumed once
 *  (atomic claim via rename), then gone; runs/ keeps the durable record. */
export function lastRunLine(cwd: string): string | null {
  const p = lastRunPath(cwd);
  if (!existsSync(p)) return null;
  const consuming = `${p}.consuming`;
  try {
    renameSync(p, consuming);
  } catch {
    return null; // concurrent consumer claimed it first
  }
  try {
    const last = JSON.parse(readFileSync(consuming, "utf-8"));
    let line = `gk selflearn last run: landed ${last.landed ?? 0}, rejected ${last.rejected ?? 0}`;
    if (last.families?.length) line += ` (${last.families.join(", ")})`;
    if (last.uncategorized) line += `; ${last.uncategorized} landed with no category (grouped under general)`;
    return line;
  } catch {
    return null;
  } finally {
    rmSync(consuming, { force: true });
  }
}

/** Session-start injection payload: last-run one-liner + grouped index. */
export function sessionContext(cwd: string, target: SelflearnTarget): string | null {
  const parts = [lastRunLine(cwd), skillIndex(cwd, target)].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}
