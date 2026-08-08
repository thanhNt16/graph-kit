import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type MetricName = "retrieval_hit_rate" | "tokens_per_turn" | "latency_per_turn_ms" | "memory_growth";

interface MetricEntry {
  run_id: string;
  metric: MetricName;
  value: number;
  at: string;
}

/**
 * Append one metric line to .graphkit/metrics/<runId>.json (JSONL).
 * Creates the directory if needed. Fail-open on I/O errors.
 */
export function appendMetric(projectRoot: string, runId: string, metric: MetricName, value: number): void {
  try {
    const dir = join(projectRoot, ".graphkit", "metrics");
    mkdirSync(dir, { recursive: true });
    const entry: MetricEntry = { run_id: runId, metric, value, at: new Date().toISOString() };
    appendFileSync(join(dir, `${runId}.json`), `${JSON.stringify(entry)}\n`);
  } catch {
    /* fail-open */
  }
}
