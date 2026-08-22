// Memory-recall eval (fable P3): first measurement of recall quality.
//
// FINDING (2026-08-15, measured): CBM `search_graph` over a markdown-only
// project returns 0 hits — .md files index as File/Module shells with no
// searchable content. gk-recall's semantic step was therefore dead weight;
// the skill's own Degradation path (keyword scan over .graphkit/memory) is
// the only working retriever. This eval measures THAT pipeline:
//   keyword-overlap × salience ranking → applyRecallFilters → top-5
// scoring hit_rate (must_surface in top-5) and validity_violations
// (must_not_surface surfaced — hard failure). Baseline below; no PR may
// lower hit_rate or add a violation. Exit 1 on regression.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { applyRecallFilters, loadMemories, rankByOverlap } from "../src/eval/memory-recall.js";

const HIT_RATE_BASELINE = 0.8; // committed baseline (current 0.9; mr-04 known stemming gap) — ratchet only upward

const ROOT = resolve(import.meta.dir, "..");
const FIXTURES = resolve(ROOT, "eval/cbm/memory-fixtures");
const QUERIES = YAML.parse(readFileSync(resolve(ROOT, "eval/cbm/memory-recall.yaml"), "utf-8")) as {
  id: string;
  query: string;
  must_surface: string[];
  must_not_surface: string[];
}[];

const TOP_K = 5;

let hits = 0;
let scored = 0;
const violations: string[] = [];
const detail: unknown[] = [];

const docs = loadMemories(FIXTURES);
for (const q of QUERIES) {
  const top = applyRecallFilters(rankByOverlap(q.query, docs), new Date().toISOString())
    .slice(0, TOP_K)
    .map((e) => e.id);
  for (const want of q.must_surface) {
    scored++;
    if (top.includes(want)) hits++;
    else detail.push({ id: q.id, miss: want, got: top });
  }
  for (const banned of q.must_not_surface) {
    if (top.includes(banned)) violations.push(`${q.id}: ${banned} surfaced`);
  }
}

const hitRate = scored ? hits / scored : 0;
console.log(
  JSON.stringify(
    {
      eval: "memory-recall",
      retriever: "degradation-path (keyword×salience) — CBM search_graph returns 0 on markdown-only projects",
      queries: QUERIES.length,
      scored,
      hits,
      hit_rate: +hitRate.toFixed(2),
      baseline: HIT_RATE_BASELINE,
      validity_violations: violations,
      detail,
    },
    null,
    2,
  ),
);

if (violations.length > 0 || hitRate < HIT_RATE_BASELINE) process.exit(1);
