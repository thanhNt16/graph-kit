import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { fail, ok } from "../output.js";
import { type GateResult, gateGraph } from "./gate.js";
import { loadGraph } from "./graph.js";

export function registerStatusCommand(cli: CAC) {
  cli
    .command("status", "Summarize active graph run and evidence coverage")
    .option("--json", "JSON output")
    .action(() => {
      try {
        const cwd = process.cwd();
        const runsDir = join(cwd, ".graphkit", "runs");
        const activeMarker = join(runsDir, ".active");

        // No active run → stable success exit 0.
        if (!existsSync(activeMarker)) {
          console.log(JSON.stringify(ok({ running: false, run: null, coverage: null })));
          return;
        }

        // Read current.json (best-effort).
        const currentPath = join(runsDir, "current.json");
        let run: { name?: string; started_at?: string; constraints?: Record<string, unknown> } | null = null;
        try {
          run = JSON.parse(readFileSync(currentPath, "utf-8"));
        } catch {
          // .active exists but current.json missing — still running.
        }

        // Gate evidence coverage via existing loadGraph + gateGraph.
        let coverage: GateResult | null = null;
        let gateError: string | null = null;
        try {
          const graph = loadGraph(join(cwd, "graph.yaml"));
          const evidenceDir = join(cwd, graph.outputs.evidence_dir);
          coverage = gateGraph(graph.evidence.required_keys, evidenceDir);
        } catch (e) {
          gateError = e instanceof GraphKitError ? e.code : "UNKNOWN";
        }

        console.log(
          JSON.stringify(
            ok({
              running: true,
              run,
              coverage,
              gate_error: gateError,
            }),
          ),
        );
      } catch (e) {
        console.log(
          JSON.stringify(
            e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("STATUS_ERROR", String(e)),
          ),
        );
        process.exit(1);
      }
    });
}
