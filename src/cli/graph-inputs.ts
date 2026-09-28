import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

// `gk run start --input k=v` enforcement (audit F4): graphs declare
// `inputs.<name>.required/default`, but nothing ever read them — a run started
// clean with unsatisfiable inputs. The parsing/enforcement helpers live here
// (pure, graph-file-in → answer-out) so the run.ts wiring stays a few lines;
// run start fails MISSING_INPUTS before a ledger entry exists, and provided
// values are recorded into the run's meta for the executor.

/**
 * Parse repeatable `--input k=v` flags into a provided-inputs map. The first
 * `=` separates key and value (values may themselves contain `=`); a flag
 * without one is a usage error, not a silently-dropped input.
 */
export function parseInputs(pairs: string | string[] | undefined): Record<string, string> {
  const list = pairs == null ? [] : Array.isArray(pairs) ? pairs : [pairs];
  const provided: Record<string, string> = {};
  for (const pair of list) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`BAD_INPUT: --input expects k=v, got "${pair}"`);
    }
    provided[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return provided;
}

/**
 * Required input keys (required: true, no declared default) missing from the
 * provided map. An unreadable graph yields [] — startRun owns that error path
 * (GRAPH_NOT_FOUND), so enforcement never masks it with its own failure.
 */
export function requiredMissing(graphPath: string, provided: Record<string, string>): string[] {
  let inputs: Record<string, { required?: boolean; default?: unknown }> | undefined;
  try {
    const doc = YAML.parse(readFileSync(graphPath, "utf-8")) as {
      inputs?: Record<string, { required?: boolean; default?: unknown }>;
    } | null;
    inputs = doc?.inputs;
  } catch {
    return [];
  }
  if (!inputs || typeof inputs !== "object") return [];
  return Object.keys(inputs).filter(
    (name) => inputs?.[name]?.required === true && inputs[name].default === undefined && !(name in provided),
  );
}

/**
 * Merge provided inputs into the run's meta.json (provenance for the
 * executor). Best-effort: an unreadable meta never blocks a live run.
 */
export function recordRunInputs(runDir: string, inputs: Record<string, string>): void {
  const metaPath = join(runDir, "meta.json");
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
    meta.inputs = inputs;
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  } catch {
    // meta unreadable — keep the run alive, skip the provenance write
  }
}
