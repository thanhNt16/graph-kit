// src/memory/recall-expanded.ts
// Recall over root + subfolders (patterns/, suggestions/) with link expansion.
// A thin projection of explainRecall — the explain lens owns the BM25 scoring,
// the filters, and the link join; this module only reshapes its hits.
import { explainRecall } from "./explain-recall.js";

export interface ExpandedHit {
  id: string;
  file: string;
  /** Final score — linked neighbors rank below direct hits. */
  salience: number;
  linked: boolean;
}

export interface ExpandedRecall {
  results: ExpandedHit[];
  linked: number;
  scanned: number;
}

export function expandedRecall(memDir: string, query: string, k = 5, now = new Date().toISOString()): ExpandedRecall {
  const exp = explainRecall(memDir, query, k, now);
  const results = exp.hits.map((h) => ({
    id: h.id,
    file: h.file,
    salience: h.final_score,
    linked: h.linked_via !== undefined,
  }));
  return { results, linked: results.filter((h) => h.linked).length, scanned: exp.scanned_count };
}
