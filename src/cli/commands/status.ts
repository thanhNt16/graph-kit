import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { fail, ok } from "../output.js";
import { type GateResult, gateGraph } from "./gate.js";
import { loadGraph } from "./graph.js";

interface StatusData {
  running: boolean;
  run: { name?: string; started_at?: string; round?: unknown; constraints?: Record<string, unknown> } | null;
  coverage: GateResult | null;
  gate_error?: string | null;
}

// Human default: run, round, coverage, verdict — the four fields a human
// checking "where is my run" actually wants. --json keeps the full envelope
// (unchanged shape: agents and scripts parse it).
export function renderStatus(data: StatusData): string {
  if (!data.running) return "no active run";
  const lines: string[] = [`run: ${data.run?.name ?? "unknown"}`];
  const round = data.run?.round;
  lines.push(`round: ${typeof round === "number" ? round : "-"}`);
  if (data.gate_error) {
    lines.push(`coverage: unavailable (${data.gate_error})`);
    lines.push("verdict: -");
  } else if (data.coverage) {
    const { scorecard, verdict } = data.coverage;
    const keys = Object.keys(scorecard);
    const okN = keys.filter((k) => scorecard[k] === "ok").length;
    lines.push(`coverage: ${okN}/${keys.length} keys ok`);
    lines.push(`verdict: ${verdict}`);
    const missing = keys.filter((k) => scorecard[k] !== "ok");
    if (missing.length > 0) lines.push(`missing: ${missing.join(", ")}`);
  } else {
    lines.push("coverage: -");
    lines.push("verdict: -");
  }
  return lines.join("\n");
}

export function registerStatusCommand(cli: CAC) {
  cli
    .command("status", "Summarize active graph run and evidence coverage")
    .option("--json", "JSON output")
    .action((opts: { json?: boolean }) => {
      try {
        const cwd = process.cwd();
        const runsDir = join(cwd, ".graphkit", "runs");
        const activeMarker = join(runsDir, ".active");

        // No active run → stable success exit 0.
        if (!existsSync(activeMarker)) {
          const data: StatusData = { running: false, run: null, coverage: null };
          console.log(opts.json ? JSON.stringify(ok(data)) : renderStatus(data));
          return;
        }

        // Read current.json (best-effort).
        const currentPath = join(runsDir, "current.json");
        let run: StatusData["run"] = null;
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
          coverage = gateGraph(graph.evidence.required_keys, evidenceDir, { cwd });
        } catch (e) {
          gateError = e instanceof GraphKitError ? e.code : "UNKNOWN";
        }

        const data: StatusData = { running: true, run, coverage, gate_error: gateError };
        console.log(opts.json ? JSON.stringify(ok(data)) : renderStatus(data));
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
