import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GraphKitError } from "../errors.js";
import { readAdvisorEvents, readDispatches, readTrace, type TraceEntry } from "./ledger.js";

/**
 * Trace-level evaluation (grade actions, not just artifacts).
 *
 * The evidence plane grades output: criteria check that artifacts exist and
 * are fresh. What a node DID — which dispatches fired, which rounds it took,
 * what evidence each attempt produced, how it ended — already lives in the
 * run journal (trace.jsonl + dispatch.jsonl + advisor.jsonl) but was never
 * exposed to graders. `materializeNodeTrace` derives a deterministic,
 * scoped view of that journal for an eval-role node at dispatch time and
 * writes it to `.graphkit/runs/<run-id>/trace/<node-id>.jsonl` — derived
 * data, not new instrumentation, so the hash-chained ledger stays the only
 * source of truth.
 *
 * One JSONL entry per journal event touching a scoped node, each carrying a
 * `kind` discriminator:
 *   - "dispatch" — the pre-launch intent record (dispatch.jsonl)
 *   - "trace"    — a node's terminal round result (trace.jsonl: ok/fail/
 *                  skipped/challenge), evidence keys included
 *   - "landed"   — an integration stamp (trace.jsonl LandEvent)
 *   - "advisor"  — a read-only escalation event (advisor.jsonl)
 * Entries are ordered by their `at` timestamp; the ledger's own append order
 * breaks ties, so identical inputs always produce identical bytes.
 */

export interface TraceEvalEntry {
  kind: "dispatch" | "trace" | "landed" | "advisor";
  at: string;
  node: string;
  [key: string]: unknown;
}

/** Resolve a run id to its ledger dir — the active run's own id resolves too. */
function runDirFor(cwd: string, id: string): string {
  const dir = join(cwd, ".graphkit", "runs", id);
  if (!existsSync(dir))
    throw new GraphKitError("TRACE_RUN_NOT_FOUND", `no run "${id}" under ${join(cwd, ".graphkit", "runs")}`);
  return dir;
}

/** The scoped journal view for one eval-role node: every dispatch, round
 *  result, land stamp and advisor event touching a node in `scope`, ordered
 *  by timestamp. Pure read — callers write the result wherever they need. */
export function traceForScope(cwd: string, id: string, scope: string[]): TraceEvalEntry[] {
  runDirFor(cwd, id); // existence check → clean TRACE_RUN_NOT_FOUND over a crash
  const wanted = new Set(scope);
  const entries: TraceEvalEntry[] = [];
  for (const d of readDispatches(cwd, id)) {
    if (wanted.has(d.node)) entries.push({ kind: "dispatch", ...d });
  }
  for (const t of readTrace(cwd, id)) {
    if (!wanted.has(t.node)) continue;
    const kind: TraceEvalEntry["kind"] = t.status === "landed" ? "landed" : "trace";
    entries.push({ kind, ...(t as TraceEntry & Record<string, unknown>) });
  }
  for (const a of readAdvisorEvents(cwd, id)) {
    if (wanted.has(a.node)) entries.push({ kind: "advisor", ...a });
  }
  entries.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return entries;
}

/** Materialize the scoped journal for eval-role node `nodeId` under
 *  `.graphkit/runs/<id>/trace/<nodeId>.jsonl` and return the absolute path.
 *  Called by the engine each dispatch round so the grader sees the journal
 *  as it stood when the gate was dispatched — regenerated, never appended,
 *  so retries and resume re-runs rewrite the same deterministic file. */
export function materializeNodeTrace(cwd: string, id: string, nodeId: string, scope: string[]): string {
  const dir = runDirFor(cwd, id);
  const entries = traceForScope(cwd, id, scope);
  const traceDir = join(dir, "trace");
  mkdirSync(traceDir, { recursive: true });
  const file = join(traceDir, `${nodeId}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""));
  return file;
}
