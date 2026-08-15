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

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { applyRecallFilters, type RecallEntry } from "../src/eval/memory-recall.js";

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

interface MemoryDoc extends RecallEntry {
  terms: Set<string>;
  salience: number;
}

function load(): MemoryDoc[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = readFileSync(resolve(FIXTURES, f), "utf-8");
      const fm = (YAML.parse(raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "{}") ?? {}) as Record<string, unknown>;
      const terms = new Set(
        raw
          .toLowerCase()
          .replace(/[^a-z0-9_\s]/g, " ")
          .split(/\s+/)
          .filter((t) => t.length > 2),
      );
      return {
        id: String(fm.id ?? f.replace(/\.md$/, "")),
        file: f,
        valid_from: fm.valid_from as string | undefined,
        valid_to: fm.valid_to as string | undefined,
        expired: fm.expired as boolean | undefined,
        superseded_by: fm.superseded_by as string | undefined,
        salience: typeof fm.salience === "number" ? fm.salience : 0.5,
        terms,
      };
    });
}

// gk-recall Degradation-path retriever: term overlap × salience
function rank(query: string, docs: MemoryDoc[]): MemoryDoc[] {
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

let hits = 0;
let scored = 0;
const violations: string[] = [];
const detail: unknown[] = [];

const docs = load();
for (const q of QUERIES) {
  const top = applyRecallFilters(rank(q.query, docs), new Date().toISOString())
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
