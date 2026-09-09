// src/memory/recall-expanded.ts
// Recall over root + subfolders (patterns/, suggestions/), with .links.json
// neighbors joining below direct hits. Imports the frozen retriever from
// src/eval — this module only widens the doc set and joins the link graph.
import {
  applyRecallFilters,
  type MemoryDoc,
  queryTerms,
  type RecallHit,
  rankByOverlap,
  termsOf,
} from "../eval/memory-recall.js";
import { walkMemoryStore } from "./frontmatter.js";
import { readLinks } from "./links.js";

export interface ExpandedHit extends RecallHit {
  linked: boolean;
  /** store-relative path ("patterns/p1.md") — the single-file reinforcement target */
  path: string;
  /** keyword-overlap × salience score the ranker used (linked hits: 0.5× salience) */
  score: number;
}

export interface ExpandedRecall {
  results: ExpandedHit[];
  linked: number;
  scanned: number;
}

const LINK_PENALTY = 0.5; // linked-not-keyword ranks below any direct hit

export function expandedRecall(memDir: string, query: string, k = 5, now = new Date().toISOString()): ExpandedRecall {
  const docs: MemoryDoc[] = [];
  const where = new Map<string, string>(); // id → store-relative file path
  for (const entry of walkMemoryStore(memDir, { skip: ["index.md", "log.md"] })) {
    docs.push({
      id: entry.id,
      file: entry.file,
      valid_from: entry.fm.valid_from,
      valid_to: entry.fm.valid_to ?? undefined,
      expired: entry.fm.expired,
      superseded_by: entry.fm.superseded_by ?? undefined,
      salience: typeof entry.fm.salience === "number" ? entry.fm.salience : 0.5,
      terms: termsOf(entry.raw),
    });
    where.set(entry.id, entry.file);
  }

  const direct = applyRecallFilters(rankByOverlap(query, docs), now) as MemoryDoc[];
  const qTerms = queryTerms(query);
  const hits: ExpandedHit[] = direct.slice(0, k).map((d) => ({
    id: d.id,
    file: where.get(d.id) ?? d.file,
    salience: d.salience,
    linked: false,
    path: where.get(d.id) ?? d.file,
    score: qTerms.filter((t) => d.terms.has(t)).length * d.salience,
  }));

  // Link expansion: neighbors of direct hits fill leftover slots, penalized.
  const graph = readLinks(memDir);
  const seen = new Set(hits.map((h) => h.id));
  let linked = 0;
  outer: for (const hit of [...hits]) {
    for (const n of graph.links[hit.id] ?? []) {
      if (seen.has(n)) continue;
      const doc = docs.find((d) => d.id === n);
      if (!doc) continue; // neighbor must exist as a loaded doc to be returnable
      if (hits.length >= k) break outer;
      hits.push({
        id: n,
        file: where.get(n) ?? doc.file,
        salience: doc.salience * LINK_PENALTY,
        linked: true,
        path: where.get(n) ?? doc.file,
        score: doc.salience * LINK_PENALTY,
      });
      seen.add(n);
      linked += 1;
    }
  }

  return { results: hits, linked, scanned: docs.length };
}
