import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendMetric } from "../../src/eval/metrics.js";

const TMP = join(import.meta.dir, "..", ".tmp-metrics");

describe("appendMetric", () => {
  beforeAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  });
  afterAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  });

  test("writes JSONL line to .graphkit/metrics/<runId>.json", () => {
    appendMetric(TMP, "r1", "retrieval_hit_rate", 0.85);
    const file = join(TMP, ".graphkit", "metrics", "r1.json");
    expect(existsSync(file)).toBe(true);

    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.run_id).toBe("r1");
    expect(entry.metric).toBe("retrieval_hit_rate");
    expect(entry.value).toBe(0.85);
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("appends multiple metrics to the same run file", () => {
    appendMetric(TMP, "r2", "tokens_per_turn", 340);
    appendMetric(TMP, "r2", "latency_per_turn_ms", 2100);
    appendMetric(TMP, "r2", "memory_growth", 12);

    const file = join(TMP, ".graphkit", "metrics", "r2.json");
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);

    const metrics = lines.map((l) => JSON.parse(l).metric);
    expect(metrics).toEqual(["tokens_per_turn", "latency_per_turn_ms", "memory_growth"]);
  });
});
