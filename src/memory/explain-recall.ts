import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dropInvalid, loadMemories, type MemoryDoc, resolveSuperseded } from "../eval/memory-recall.js";
import { readLinks } from "./links.js";

export type ExplainDocStatus = "hit" | "filtered" | "rejected";

export type ExplainRejectReason = "zero_overlap" | "expired" | "not_yet_valid" | "superseded" | "outranked";

export interface DocExplain {
  id: string;
  file: string;
  matched_terms: string[];
  raw_salience: number;
  final_score: number;
  status: ExplainDocStatus;
  reason?: ExplainRejectReason;
  superseded_by?: string;
  linked_via?: string;
  linked_penalty?: number;
}

export interface RecallExplanation {
  query: string;
  query_terms: string[];
  now: string;
  k: number;
  scanned_count: number;
  malformed_count: number;
  hits: DocExplain[];
  rejected_top_n: DocExplain[];
}

const LINK_PENALTY = 0.5;

function recallDirs(memDir: string): Array<{ dir: string; prefix: string }> {
  if (!existsSync(memDir)) return [];
  const dirs = [{ dir: memDir, prefix: "" }];
  for (const de of readdirSync(memDir, { withFileTypes: true })) {
    if (de.isDirectory() && !de.name.startsWith(".")) {
      dirs.push({ dir: join(memDir, de.name), prefix: `${de.name}/` });
    }
  }
  return dirs;
}

export function explainRecall(memDir: string, query: string, k = 5, now = new Date().toISOString()): RecallExplanation {
  const docs: MemoryDoc[] = [];
  const where = new Map<string, string>();

  for (const { dir, prefix } of recallDirs(memDir)) {
    for (const d of loadMemories(dir)) {
      docs.push(d);
      where.set(d.id, prefix + d.file);
    }
  }

  const qTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  // Score docs based on query term overlap
  const scored = docs.map((doc) => {
    const matched = qTerms.filter((t) => doc.terms.has(t));
    const score = matched.length * doc.salience;
    return { doc, matched, score };
  });

  // Track validity drops
  const validMap = new Map(dropInvalid(docs, now).map((d) => [d.id, d]));
  const resolvedMap = new Map(resolveSuperseded(Array.from(validMap.values())).map((d) => [d.id, d]));

  // Sort overlapping docs descending by score
  const overlapping = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

  const directHits: DocExplain[] = [];
  const rejectedOrFiltered: DocExplain[] = [];

  for (const item of overlapping) {
    const { doc, matched, score } = item;
    const relFile = where.get(doc.id) ?? doc.file;

    // Check expiry / validity
    if (!validMap.has(doc.id)) {
      const isNotYetValid = Boolean(doc.valid_from && Date.parse(doc.valid_from) > Date.parse(now));
      rejectedOrFiltered.push({
        id: doc.id,
        file: relFile,
        matched_terms: matched,
        raw_salience: doc.salience,
        final_score: score,
        status: "filtered",
        reason: isNotYetValid ? "not_yet_valid" : "expired",
      });
      continue;
    }

    // Check supersede
    if (!resolvedMap.has(doc.id)) {
      rejectedOrFiltered.push({
        id: doc.id,
        file: relFile,
        matched_terms: matched,
        raw_salience: doc.salience,
        final_score: score,
        status: "filtered",
        reason: "superseded",
        superseded_by: doc.superseded_by,
      });
      continue;
    }

    // Survives filters
    if (directHits.length < k) {
      directHits.push({
        id: doc.id,
        file: relFile,
        matched_terms: matched,
        raw_salience: doc.salience,
        final_score: score,
        status: "hit",
      });
    } else {
      rejectedOrFiltered.push({
        id: doc.id,
        file: relFile,
        matched_terms: matched,
        raw_salience: doc.salience,
        final_score: score,
        status: "rejected",
        reason: "outranked",
      });
    }
  }

  // Link expansion for leftover slots
  const graph = readLinks(memDir);
  const seen = new Set(directHits.map((h) => h.id));
  const hits = [...directHits];

  if (hits.length < k) {
    outer: for (const hit of directHits) {
      for (const neighborId of graph.links[hit.id] ?? []) {
        if (seen.has(neighborId)) continue;
        const neighborDoc = docs.find((d) => d.id === neighborId);
        if (!neighborDoc) continue;
        if (hits.length >= k) break outer;

        const relFile = where.get(neighborDoc.id) ?? neighborDoc.file;
        const neighborMatched = qTerms.filter((t) => neighborDoc.terms.has(t));
        const penalizedScore = neighborDoc.salience * LINK_PENALTY;

        hits.push({
          id: neighborDoc.id,
          file: relFile,
          matched_terms: neighborMatched,
          raw_salience: neighborDoc.salience,
          final_score: penalizedScore,
          status: "hit",
          linked_via: hit.id,
          linked_penalty: LINK_PENALTY,
        });
        seen.add(neighborId);
      }
    }
  }

  // Zero-overlap docs that are high salience can be added to rejected if needed
  const zeroOverlap = scored.filter((s) => s.score === 0).sort((a, b) => b.doc.salience - a.doc.salience);

  for (const item of zeroOverlap) {
    if (rejectedOrFiltered.length >= 10) break;
    rejectedOrFiltered.push({
      id: item.doc.id,
      file: where.get(item.doc.id) ?? item.doc.file,
      matched_terms: [],
      raw_salience: item.doc.salience,
      final_score: 0,
      status: "rejected",
      reason: "zero_overlap",
    });
  }

  return {
    query,
    query_terms: qTerms,
    now,
    k,
    scanned_count: docs.length,
    malformed_count: 0,
    hits,
    rejected_top_n: rejectedOrFiltered.slice(0, 5),
  };
}
