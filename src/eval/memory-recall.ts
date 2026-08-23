// Pure recall filters — the reference implementation of gk-recall steps 4-5
// (temporal validity + supersede resolution). Unit-tested; the eval runner and
// the skill both apply exactly these rules.

export interface RecallEntry {
  id: string;
  file: string;
  /** parsed frontmatter fields the filters need */
  valid_from?: string;
  valid_to?: string;
  expired?: boolean;
  superseded_by?: string;
}

/** Drop expired, not-yet-valid, past-valid entries (gk-recall step 4). */
export function dropInvalid(entries: RecallEntry[], now: string): RecallEntry[] {
  const t = Date.parse(now);
  return entries.filter((e) => {
    if (e.expired === true) return false;
    if (e.valid_from && Date.parse(e.valid_from) > t) return false;
    if (e.valid_to && Date.parse(e.valid_to) < t) return false;
    return true;
  });
}

/** Resolve supersede chains: replace a superseded head with its current version
 *  if present, else drop it (gk-recall step 5 — surface only the newest member). */
export function resolveSuperseded(entries: RecallEntry[]): RecallEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out: RecallEntry[] = [];
  for (const e of entries) {
    if (!e.superseded_by) {
      if (!out.some((o) => o.id === e.id)) out.push(e);
      continue;
    }
    // follow the chain to its current, present member
    let cur = e.superseded_by;
    const seen = new Set([e.id]);
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const next = byId.get(cur);
      if (!next) break;
      if (!next.superseded_by) break;
      cur = next.superseded_by;
    }
    const successor = cur && byId.has(cur) ? byId.get(cur) : undefined;
    if (successor && !successor.superseded_by && !out.includes(successor)) out.push(successor);
  }
  return out;
}

/** Full recall filter pipeline (validity, then supersede). */
export function applyRecallFilters(entries: RecallEntry[], now: string): RecallEntry[] {
  return resolveSuperseded(dropInvalid(entries, now));
}

// ── the working retriever ────────────────────────────────────────────────────
// Measured 2026-08-15 (memory-recall eval): CBM search_graph returns 0 hits
// over markdown-only projects — .md indexes as File/Module shells with no
// searchable content. Term-overlap × salience over the files themselves is
// the only working memory retriever; this is it, shared by the CLI and the eval.

import { readdirSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import YAML from "yaml";
import { MemoryFileSchema } from "../schemas/memory.schema.js";

export interface MemoryDoc extends RecallEntry {
  salience: number;
  terms: Set<string>;
}

interface LoadedMemories {
  docs: MemoryDoc[];
  malformed: number;
}

function readMemories(dir: string): LoadedMemories {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { docs: [], malformed: 0 };
    throw error;
  }

  const docs: MemoryDoc[] = [];
  let malformed = 0;
  for (const file of files.filter((f) => f.endsWith(".md") && f !== "index.md" && f !== "log.md")) {
    const raw = readFileSync(pathResolve(dir, file), "utf-8");
    try {
      const parsedYaml = YAML.parse(raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "{}");
      const fm = parsedYaml && typeof parsedYaml === "object" ? (parsedYaml as Record<string, unknown>) : {};
      // Legacy stores omitted type; infer the historical knowledge type before validation.
      const candidate = {
        ...fm,
        id: typeof fm.id === "string" && fm.id.trim() ? fm.id : file.replace(/\.md$/, ""),
        type: typeof fm.type === "string" && fm.type.trim() ? fm.type : "knowledge",
      };
      const validated = MemoryFileSchema.safeParse(candidate);
      if (!validated.success) {
        malformed++;
        continue;
      }
      const value = validated.data;
      docs.push({
        id: value.id,
        file,
        valid_from: value.valid_from,
        valid_to: value.valid_to ?? undefined,
        expired: value.expired,
        superseded_by: value.superseded_by ?? undefined,
        salience: typeof value.salience === "number" ? value.salience : 0.5,
        terms: new Set(
          raw
            .toLowerCase()
            .replace(/[^a-z0-9_\s]/g, " ")
            .split(/\s+/)
            .filter((t) => t.length > 2),
        ),
      });
    } catch {
      malformed++;
    }
  }
  return { docs, malformed };
}

export function loadMemories(dir: string): MemoryDoc[] {
  return readMemories(dir).docs;
}

export interface RecallWithStats {
  results: RecallHit[];
  malformed: number;
}

export function recallWithStats(dir: string, query: string, k = 5, now = new Date().toISOString()): RecallWithStats {
  const loaded = readMemories(dir);
  const filtered = applyRecallFilters(rankByOverlap(query, loaded.docs), now) as MemoryDoc[];
  return {
    results: filtered.slice(0, k).map((e) => ({ id: e.id, file: e.file, salience: e.salience })),
    malformed: loaded.malformed,
  };
}

export function rankByOverlap(query: string, docs: MemoryDoc[]): MemoryDoc[] {
  const q = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  return docs
    .map((d) => ({ d, s: q.filter((t) => d.terms.has(t)).length * d.salience }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.d);
}

export interface RecallHit {
  id: string;
  file: string;
  salience: number;
}

/** rank → validity/supersede filters → top-k (filters run on the full ranked
 *  list — supersede resolution needs the successor even when it ranks low). */
export function recallTopK(dir: string, query: string, k = 5, now = new Date().toISOString()): RecallHit[] {
  // input is MemoryDoc[]; the filter signatures just carry the base type
  const filtered = applyRecallFilters(rankByOverlap(query, loadMemories(dir)), now) as MemoryDoc[];
  return filtered.slice(0, k).map((e) => ({ id: e.id, file: e.file, salience: e.salience }));
}
