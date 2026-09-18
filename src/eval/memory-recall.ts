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
// searchable content. BM25 × salience over the files themselves is the only
// working memory retriever; shared by the CLI, the explain lens, and the eval.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readMemoryFile, tokenize, tokenizeList, walkMemoryFiles } from "../memory/store.js";
import { MemoryFileSchema } from "../schemas/memory.schema.js";

export interface MemoryDoc extends RecallEntry {
  salience: number;
  terms: Set<string>;
  /** Within-document term frequencies (BM25 input). */
  tf: Map<string, number>;
}

interface LoadedMemories {
  docs: MemoryDoc[];
  malformed: number;
}

function termFreqs(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokenizeList(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/** Schema-validate frontmatter and build a doc; null = malformed entry. */
function toDoc(fm: Record<string, unknown>, head: string, body: string, file: string): MemoryDoc | null {
  // Legacy stores omitted type; infer the historical knowledge type before validation.
  const candidate = {
    ...fm,
    id: typeof fm.id === "string" && fm.id.trim() ? fm.id : file.replace(/^.*\//, "").replace(/\.md$/, ""),
    type: typeof fm.type === "string" && fm.type.trim() ? fm.type : "knowledge",
  };
  const validated = MemoryFileSchema.safeParse(candidate);
  if (!validated.success) return null;
  const value = validated.data;
  const text = `${head}\n${body}`;
  const tf = termFreqs(text);
  return {
    id: value.id,
    file,
    valid_from: value.valid_from,
    valid_to: value.valid_to ?? undefined,
    expired: value.expired,
    superseded_by: value.superseded_by ?? undefined,
    salience: typeof value.salience === "number" ? value.salience : 0.5,
    terms: new Set(tf.keys()),
    tf,
  };
}

/** Flat single-directory read (the eval fixtures' layout). */
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
    const { fm, head, body, error } = readMemoryFile(join(dir, file));
    if (error === "unreadable") continue;
    const doc = error === "unparseable" ? null : toDoc(fm, head, body, file);
    if (!doc) {
      malformed++;
      continue;
    }
    docs.push(doc);
  }
  return { docs, malformed };
}

/** Load the whole store: root + one sublevel (patterns/, suggestions/), with
 *  store-relative file paths and the real malformed-entry count. */
export function loadMemories(memDir: string): LoadedMemories {
  const docs: MemoryDoc[] = [];
  let malformed = 0;
  for (const { rel, path } of walkMemoryFiles(memDir)) {
    const { fm, head, body, error } = readMemoryFile(path);
    if (error === "unreadable") continue;
    const doc = error === "unparseable" ? null : toDoc(fm, head, body, rel);
    if (!doc) {
      malformed++;
      continue;
    }
    docs.push(doc);
  }
  return { docs, malformed };
}

export interface RecallWithStats {
  results: RecallHit[];
  malformed: number;
}

export function recallWithStats(dir: string, query: string, k = 5, now = new Date().toISOString()): RecallWithStats {
  const loaded = readMemories(dir);
  // rank (BM25×salience) → relative cutoff → validity/supersede filters → top-k
  // (filters run on the full kept list — supersede resolution needs the
  // successor even when it ranks low).
  const kept = applyCutoff(scoreDocs(query, loaded.docs));
  const filtered = applyRecallFilters(
    kept.map((s) => s.doc),
    now,
  ) as MemoryDoc[];
  return {
    results: filtered.slice(0, k).map((e) => ({ id: e.id, file: e.file, salience: e.salience })),
    malformed: loaded.malformed,
  };
}

export interface ScoredDoc {
  doc: MemoryDoc;
  score: number;
  matched: string[];
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Okapi BM25 over the loaded docs (tiny corpus — recompute df per call),
 *  scaled by each doc's curated salience. Returns docs with score > 0, ranked. */
export function scoreDocs(query: string, docs: MemoryDoc[]): ScoredDoc[] {
  const q = [...tokenize(query)];
  if (q.length === 0 || docs.length === 0) return [];
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const d of docs) {
    for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    for (const f of d.tf.values()) totalLen += f;
  }
  const avgdl = totalLen / docs.length || 1;
  const scored = docs.map((d) => {
    let dl = 0;
    for (const f of d.tf.values()) dl += f;
    let bm25 = 0;
    const matched: string[] = [];
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      matched.push(t);
      const dfT = df.get(t) ?? 0;
      const idf = Math.log(1 + (docs.length - dfT + 0.5) / (dfT + 0.5));
      bm25 += (idf * f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl));
    }
    return { doc: d, score: bm25 * d.salience, matched };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

/** Hits below this fraction of the top hit's score are distractors — recall
 *  should return the strong memories, not fill k slots with noise. */
export const RELATIVE_CUTOFF = 0.3;

/** Keep scored docs within RELATIVE_CUTOFF of the top score. */
export function applyCutoff(scored: ScoredDoc[], cutoff = RELATIVE_CUTOFF): ScoredDoc[] {
  if (scored.length === 0) return scored;
  const floor = scored[0].score * cutoff;
  return scored.filter((s) => s.score >= floor);
}

export interface RecallHit {
  id: string;
  file: string;
  salience: number;
}
