import { basename, join } from "node:path";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { activeRun, readRunMeta, readTrace } from "../../memory/ledger.js";
import { resolveGraph } from "../graph-resolve.js";
import { emit, fail, ok } from "../output.js";
import { type GateResult, gateGraph } from "./gate.js";

export function registerStatusCommand(cli: CAC) {
  cli
    .command("status", "Summarize active graph run and evidence coverage")
    .option("--json", "JSON output")
    .action(() => {
      try {
        const cwd = process.cwd();

        // No active run → stable success exit 0. (A dangling .active pointer
        // counts as no run: the ledger already treats a vanished dir that way.)
        const dir = activeRun(cwd);
        if (!dir) {
          emit(ok({ running: false, run: null, coverage: null }));
          return;
        }

        // Run identity straight from the ledger: .active names the run dir,
        // meta.json enriches it, trace.jsonl tallies it. No current.json.
        const id = basename(dir);
        const run: { id: string; graph: string | null; started_at: string | null } = { id, graph: null, started_at: null };
        try {
          const meta = readRunMeta(cwd, id);
          run.graph = meta.graph;
          run.started_at = meta.started_at;
        } catch {
          // meta unreadable — the id alone is still the honest answer.
        }
        const nodes = { ok: 0, fail: 0, skipped: 0, challenge: 0 };
        for (const line of readTrace(cwd, id)) nodes[line.status]++;

        // Gate evidence coverage via the one graph resolver + gateGraph.
        let coverage: GateResult | null = null;
        let gateError: string | null = null;
        try {
          const graph = resolveGraph(cwd);
          const evidenceDir = join(cwd, graph.outputs.evidence_dir);
          coverage = gateGraph(graph.evidence.required_keys, evidenceDir, { cwd });
        } catch (e) {
          gateError = e instanceof GraphKitError ? e.code : "UNKNOWN";
        }

        emit(
          ok({
            running: true,
            run,
            nodes,
            coverage,
            gate_error: gateError,
          }),
        );
      } catch (e) {
        emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("STATUS_ERROR", String(e)));
      }
    });
}
