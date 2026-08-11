import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { scoreMemory, scoreWorkProduct } from "./rubrics.js";

export interface GoldenResult {
  id: string;
  category: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface GoldenReport {
  total: number;
  perCategory: Record<string, { pass: number; total: number }>;
  results: GoldenResult[];
}

export function runGolden(dir: string): GoldenReport {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  const results: GoldenResult[] = files.map((f) => {
    const c = YAML.parse(readFileSync(join(dir, f), "utf-8"));
    let actual: string;
    if (c.mode === "work_product") {
      actual = scoreWorkProduct(c.input, c.evidence || {}, c.rubric || "strict").verdict;
    } else {
      const overall = scoreMemory(c.memory_state, c.opts).overall;
      actual = overall >= (c.expected_min_overall ?? 0.5) ? "PASS" : "FAIL";
    }
    const expected = c.expected_verdict ?? "PASS";
    return {
      id: c.id,
      category: c.category,
      expected,
      actual,
      pass: actual === expected,
    };
  });

  const perCategory: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    perCategory[r.category] ??= { pass: 0, total: 0 };
    perCategory[r.category].total++;
    if (r.pass) perCategory[r.category].pass++;
  }
  return { total: results.length, perCategory, results };
}
