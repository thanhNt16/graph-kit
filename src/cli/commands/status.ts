import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { activeRun, activeRunGraph, readRunMeta, readTrace } from "../../memory/ledger.js";
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
        // The ledger is authoritative: a run started by `gk run start` carries
        // its identity (id/graph/started_at) in the run dir's meta.json — the
        // agent-authored current.json sidecar never updates it, so name used
        // to read "unknown" for every real run.
        const ledgerDir = activeRun(cwd);

        // No active run → stable success exit 0. A ledger run wins; an
        // agent-authored .active without a valid run dir still counts as
        // running (sidecar data below), matching the pre-ledger contract.
        if (!ledgerDir && !existsSync(activeMarker)) {
          const data: StatusData = { running: false, run: null, coverage: null };
          console.log(opts.json ? JSON.stringify(ok(data)) : renderStatus(data));
          return;
        }

        const run: NonNullable<StatusData["run"]> = {};
        const ledgerId = ledgerDir ? basename(ledgerDir) : null;
        if (ledgerId) {
          run.name = ledgerId;
          try {
            run.started_at = readRunMeta(cwd, ledgerId).started_at;
          } catch {
            /* dangling pointer — render the id alone */
          }
        }

        // Agent state sidecar (best-effort): round + constraints are authored
        // by the executing agent; name/started_at only when the ledger has no
        // run dir for the pointer.
        try {
          const sidecar = JSON.parse(readFileSync(join(runsDir, "current.json"), "utf-8")) as Record<string, unknown>;
          if (typeof sidecar.round === "number") run.round = sidecar.round;
          if (sidecar.constraints && typeof sidecar.constraints === "object") {
            run.constraints = sidecar.constraints as Record<string, unknown>;
          }
          if (!ledgerId && typeof sidecar.name === "string") run.name = sidecar.name;
          if (!ledgerId && typeof sidecar.started_at === "string") run.started_at = sidecar.started_at;
        } catch {
          // no sidecar — ledger data only
        }

        // Round fallback when the agent hasn't authored one: highest completed
        // wave + 1, the same derivation `gk run status` prints.
        if (run.round === undefined && ledgerId) {
          try {
            const waves = readTrace(cwd, ledgerId)
              .map((t) => t.wave)
              .filter((w): w is number => w != null);
            run.round = waves.length ? Math.max(...waves) + 1 : 0;
          } catch {
            /* no trace yet — round stays unset */
          }
        }

        // Gate evidence coverage via existing loadGraph + gateGraph. Coverage
        // must score the graph the ACTIVE RUN executes (meta.graph_path — a
        // resumed run's derived session graph shrinks required_keys to the
        // pending set), falling back to cwd/graph.yaml only when no run is
        // recording a path; scoring the parent graph made a satisfied resumed
        // run report missing keys — a permanent BLOCK it could never clear.
        let coverage: GateResult | null = null;
        let gateError: string | null = null;
        try {
          const graph = loadGraph(activeRunGraph(cwd) ?? join(cwd, "graph.yaml"));
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
