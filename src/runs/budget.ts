import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { GraphSchema } from "../schemas/graph.schema.js";
import { isNodeLine, type RunMeta, readDispatches, readTrace } from "./ledger.js";

// Run-level context budget accounting. `allocated` is planning currency —
// the sum of DISPATCHED nodes' declared `budget_tokens` against the graph's
// `budget.max_tokens` cap. GraphKit cannot meter host-side API tokens, so the
// ledger charges declared allocations only; the field names say so. A node's
// declared allocation counts once, however many attempts it retries.
export const BUDGET_TRIP_NOTE = "budget_exceeded";

export interface BudgetStatus {
  max: number;
  warn_at: number;
  allocated: number;
  remaining: number;
  warn: boolean;
  exceeded: boolean;
  /** Node whose declared allocation tripped the cap, if the trace shows one. */
  tripped_by: string | null;
}

/** Declared `budget_tokens` per node id, parsed from the run's recorded
 *  graph. An unreadable or drifted graph degrades to an empty map (zero
 *  allocations), matching analyze.ts's loadGraph posture. */
function declaredBudgets(graphPath: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!graphPath || !existsSync(graphPath)) return out;
  try {
    const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(graphPath, "utf-8")));
    if (!parsed.success) return out;
    for (const [id, n] of Object.entries(parsed.data.nodes)) out.set(id, n.budget_tokens ?? 0);
  } catch {
    /* degraded: zero allocations */
  }
  return out;
}

/** Budget accounting for one run: meta.budget (recorded at startRun) plus
 *  the recorded graph's declared allocations. Dispatched ids come from both
 *  dispatch intents and trace lines so host-driven and engine-driven runs
 *  accumulate the same way. null when the run recorded no budget. */
export function budgetStatus(cwd: string, runId: string, meta: RunMeta): BudgetStatus | null {
  const budget = meta.budget;
  if (budget == null) return null;
  const declared = declaredBudgets(meta.graph_path);
  const dispatched = new Set<string>([
    ...readDispatches(cwd, runId).map((d) => d.node),
    ...readTrace(cwd, runId)
      .filter(isNodeLine)
      .map((l) => l.node),
  ]);
  let allocated = 0;
  for (const id of dispatched) allocated += declared.get(id) ?? 0;
  const trace = readTrace(cwd, runId).filter(isNodeLine);
  const tripped = trace.find((l) => l.notes?.startsWith(BUDGET_TRIP_NOTE));
  return {
    max: budget.max_tokens,
    warn_at: budget.warn_at,
    allocated,
    remaining: budget.max_tokens - allocated,
    warn: allocated >= budget.warn_at * budget.max_tokens,
    exceeded: allocated > budget.max_tokens,
    tripped_by: tripped?.node ?? null,
  };
}
