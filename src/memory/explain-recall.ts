import {
  applyCutoff,
  applyRecallFilters,
  loadMemories,
  type MemoryDoc,
  type ScoredDoc,
  scoreDocs,
} from "../eval/memory-recall.js";
import { readLinks } from "./links.js";
import { tokenize } from "./store.js";

export type ExplainDocStatus = "hit" | "filtered" | "rejected";

export type ExplainRejectReason =
  | "zero_overlap"
  | "expired"
  | "not_yet_valid"
  | "superseded"
  | "below_cutoff"
  | "outranked";

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
  /** Personalized-PageRank mass that admitted this neighbor. */
  ppr_mass?: number;
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

const PPR_DAMPING = 0.85;
const PPR_ITERATIONS = 3;
const REJECTED_POOL_MAX = 10; // zero-overlap candidates worth reporting
const REJECTED_TOP_N = 5; // what rejected_top_n keeps

/** Personalized PageRank over the undirected link graph, seeded with
 *  normalized direct-hit scores. Replaces the flat 0.5 link penalty: mass
 *  flows along the graph, so a neighbor enmeshed with strong hits inherits
 *  more of their evidence than a fringe neighbor. Deterministic. */
function pageRank(links: Record<string, string[]>, seeds: Map<string, number>): Map<string, number> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const [id, ns] of Object.entries(links)) for (const n of ns) link(id, n);

  const total = [...seeds.values()].reduce((a, b) => a + b, 0);
  if (!(total > 0)) return new Map();
  let p = new Map([...seeds].map(([id, s]) => [id, s / total]));
  for (let i = 0; i < PPR_ITERATIONS; i += 1) {
    const next = new Map([...p].map(([id]) => [id, ((1 - PPR_DAMPING) * (seeds.get(id) ?? 0)) / total]));
    for (const [id, mass] of p) {
      const outs = adj.get(id);
      if (!outs || outs.size === 0) continue; // dangling mass vanishes — deterministic
      const share = (PPR_DAMPING * mass) / outs.size;
      for (const n of outs) next.set(n, (next.get(n) ?? 0) + share);
    }
    p = next;
  }
  return p;
}

export function explainRecall(memDir: string, query: string, k = 5, now = new Date().toISOString()): RecallExplanation {
  // One load pass over root + subfolders; docs carry store-relative paths.
  const { docs, malformed } = loadMemories(memDir);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const qTerms = [...tokenize(query)];

  // Score exactly once — the explain lens consumes the retriever's own numbers.
  const scored = scoreDocs(query, docs);
  const scoreOf = new Map(scored.map((s) => [s.doc.id, s]));

  // Mirror the retriever's actual ordering: rank → cutoff → filters.
  // resolveSuperseded runs over the kept list, so a successor inherits the
  // superseded doc's rank slot — classify hits against the survivor sequence,
  // not per-doc membership checks.
  const overlapping = applyCutoff(scored);
  const survivors = applyRecallFilters(
    overlapping.map((s) => s.doc),
    now,
  ) as MemoryDoc[];
  const slotOf = new Map(survivors.map((d, i) => [d.id, i]));

  const directHits: DocExplain[] = [];
  const rejectedOrFiltered: DocExplain[] = [];

  const explainOf = (s: ScoredDoc) => ({
    id: s.doc.id,
    file: s.doc.file,
    matched_terms: s.matched,
    raw_salience: s.doc.salience,
    final_score: s.score,
  });

  for (const doc of survivors) {
    const s = scoreOf.get(doc.id)!;
    if (directHits.length < k) directHits.push({ ...explainOf(s), status: "hit" });
    else rejectedOrFiltered.push({ ...explainOf(s), status: "rejected", reason: "outranked" });
  }

  for (const s of scored) {
    if (slotOf.has(s.doc.id)) continue;
    // dropInvalid ran before resolveSuperseded, so validity failures classify
    // first; a superseded entry's slot went to its successor (classified in the
    // survivor loop above); a healthy entry here was culled by the cutoff.
    const doc = s.doc;
    const notYet = Boolean(doc.valid_from && Date.parse(doc.valid_from) > Date.parse(now));
    const invalid =
      doc.expired === true || notYet || Boolean(doc.valid_to && Date.parse(doc.valid_to) < Date.parse(now));
    rejectedOrFiltered.push({
      ...explainOf(s),
      status: invalid || doc.superseded_by ? "filtered" : "rejected",
      reason: invalid ? (notYet ? "not_yet_valid" : "expired") : doc.superseded_by ? "superseded" : "below_cutoff",
      superseded_by: doc.superseded_by,
    });
  }

  // Link expansion: PPR mass (seeded by direct-hit scores) admits neighbors
  // into leftover slots, ranked below every direct hit.
  const hits = [...directHits];
  const seen = new Set(hits.map((h) => h.id));
  if (hits.length > 0 && hits.length < k) {
    const graph = readLinks(memDir);
    const seeds = new Map(directHits.map((h) => [h.id, h.final_score]));
    const ppr = pageRank(graph.links, seeds);
    // Admit neighbors in PPR-mass order (not raw adjacency order): a high-mass
    // neighbor of the k-th hit outranks a zero-mass fringe neighbor of the top hit.
    const candidates: { id: string; via: string; mass: number }[] = [];
    for (const hit of directHits) {
      for (const neighborId of graph.links[hit.id] ?? []) {
        if (seen.has(neighborId)) continue;
        seen.add(neighborId);
        candidates.push({ id: neighborId, via: hit.id, mass: ppr.get(neighborId) ?? 0 });
      }
    }
    candidates.sort((a, b) => b.mass - a.mass || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const c of candidates) {
      if (hits.length >= k) break;
      const neighborDoc = byId.get(c.id);
      if (!neighborDoc) continue; // neighbor must exist as a loaded doc to be returnable
      hits.push({
        id: neighborDoc.id,
        file: neighborDoc.file,
        matched_terms: qTerms.filter((t) => neighborDoc.terms.has(t)),
        raw_salience: neighborDoc.salience,
        final_score: neighborDoc.salience * c.mass,
        status: "hit",
        linked_via: c.via,
        ppr_mass: c.mass,
      });
    }
  }

  // Zero-overlap docs that are high salience can be added to rejected if needed
  const scoredIds = new Set(scored.map((s) => s.doc.id));
  const zeroOverlap = docs
    .filter((d) => !scoredIds.has(d.id) && !seen.has(d.id))
    .sort((a, b) => b.salience - a.salience);
  for (const doc of zeroOverlap) {
    if (rejectedOrFiltered.length >= REJECTED_POOL_MAX) break;
    rejectedOrFiltered.push({
      id: doc.id,
      file: doc.file,
      matched_terms: [],
      raw_salience: doc.salience,
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
    malformed_count: malformed,
    hits,
    rejected_top_n: rejectedOrFiltered.slice(0, REJECTED_TOP_N),
  };
}
