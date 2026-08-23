// Memory-recall eval (fable P3): recall quality over eval/cbm/memory-fixtures/.
//
// Pipeline: keyword-overlap × salience ranking → validity/supersede filters →
// top-k, via `recallWithStats` (the strict reader). Scores:
//   hit_rate            — must_surface ids present in top-5
//   validity_violations — must_not_surface ids surfaced (hard failure)
//   malformed           — entries dropped for unparseable validity dates
// Gate: hit_rate ≥ 0.8, zero violations, malformed === expected (one by-design
// fixture per fresh store read). Exit 1 on regression.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { recallWithStats } from "../src/eval/memory-recall.js";

const HIT_RATE_BASELINE = 0.8; // ratchet only upward

const NOW = "2026-08-22T00:00:00.000Z"; // frozen clock — deterministic eval, fixtures dated ≤ 2027-01-01
const TOP_K = 5;

const ROOT = resolve(import.meta.dir, "..");
const FIXTURES = resolve(ROOT, "eval/cbm/memory-fixtures");
const QUERIES = YAML.parse(readFileSync(resolve(ROOT, "eval/cbm/memory-recall.yaml"), "utf-8")) as {
  id: string;
  query: string;
  must_surface: string[];
  must_not_surface: string[];
}[];

let hits = 0;
let scored = 0;
const violations: string[] = [];
const detail: unknown[] = [];
let malformedTotal = 0;

for (const q of QUERIES) {
  // fresh read per query: recallWithStats is strict — a broken store throws,
  // it never silently scores against an empty one
  const { results, malformed } = recallWithStats(FIXTURES, q.query, TOP_K, NOW);
  malformedTotal += malformed;
  const top = results.map((r) => r.id);
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
// every query re-reads the store fresh, so the one by-design malformed fixture
// (malformed-date) is counted exactly once per read — never zero, never hidden
const malformedExpected = QUERIES.length;
console.log(
  JSON.stringify(
    {
      eval: "memory-recall",
      queries: QUERIES.length,
      scored,
      hits,
      hit_rate: +hitRate.toFixed(2),
      baseline: HIT_RATE_BASELINE,
      validity_violations: violations,
      malformed: malformedTotal,
      malformed_expected: malformedExpected,
      detail,
    },
    null,
    2,
  ),
);

if (violations.length > 0 || malformedTotal !== malformedExpected || hitRate < HIT_RATE_BASELINE)
  process.exit(1);
