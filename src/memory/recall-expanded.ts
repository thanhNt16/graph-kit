// src/memory/recall-expanded.ts
// Recall over root + subfolders (patterns/, suggestions/), with .links.json
// neighbors joining below direct hits. Imports the frozen retriever from
// src/eval — this module only widens the doc set and joins the link graph.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  applyRecallFilters,
  loadMemories,
  type MemoryDoc,
  type RecallHit,
  rankByOverlap,
} from "../eval/memory-recall.js";
import { readLinks } from "./links.js";

export interface ExpandedHit extends RecallHit {
  linked: boolean;
}

export interface ExpandedRecall {
  results: ExpandedHit[];
  linked: number;
  scanned: number;
}

const LINK_PENALTY = 0.5; // linked-not-keyword ranks below any direct hit

/** Memory root plus one sublevel, matching the consolidate layout. */
function recallDirs(memDir: string): Array<{ dir: string; prefix: string }> {
  if (!existsSync(memDir)) return [];
  const dirs = [{ dir: memDir, prefix: "" }];
  for (const de of readdirSync(memDir, { withFileTypes: true })) {
    if (de.isDirectory() && !de.name.startsWith(".")) dirs.push({ dir: join(memDir, de.name), prefix: `${de.name}/` });
  }
  return dirs;
}

export function expandedRecall(memDir: string, query: string, k = 5, now = new Date().toISOString()): ExpandedRecall {
  const docs: MemoryDoc[] = [];
  const where = new Map<string, string>(); // id → relative file path
  for (const { dir, prefix } of recallDirs(memDir)) {
    for (const d of loadMemories(dir)) {
      docs.push(d);
      where.set(d.id, prefix + d.file);
    }
  }

  const direct = applyRecallFilters(rankByOverlap(query, docs), now) as MemoryDoc[];
  const hits: ExpandedHit[] = direct
    .slice(0, k)
    .map((d) => ({ id: d.id, file: where.get(d.id) ?? d.file, salience: d.salience, linked: false }));

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
      hits.push({ id: n, file: where.get(n) ?? doc.file, salience: doc.salience * LINK_PENALTY, linked: true });
      seen.add(n);
      linked += 1;
    }
  }

  return { results: hits, linked, scanned: docs.length };
}
