import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CAC } from "cac";
import { loadGraph } from "../../compiler/loader.js";
import { validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import { scoreWorkProduct } from "../../eval/rubrics.js";
import { fingerprint } from "../../evidence/fingerprint.js";
import { type Freshness, freshnessOf, parseMarker } from "../../evidence/marker.js";
import { fail, ok, renderFindings } from "../output.js";

/**
 * Deterministic evidence gate: MERGE/BLOCK over required evidence keys.
 *
 * Evidence key → file contract (ADR-002): required key `k` maps to
 * `<evidenceDir>/<k>.md`; satisfied iff the file exists and is non-empty
 * after trim (exactly `scoreWorkProduct` strict semantics). The basename is
 * the only deterministic, zero-parser mapping — no manifest or heading
 * parsing is trusted.
 */

export interface GateResult {
  verdict: "MERGE" | "BLOCK";
  scorecard: Record<string, "ok" | "missing" | "empty">;
  freshness: Record<string, Freshness>;
  missing: string[];
  manifest: Record<string, { path: string; sha256: string; bytes: number }>;
}

export function gateGraph(
  requiredKeys: string[],
  evidenceDir: string,
  opts?: { cwd?: string; strict?: boolean },
): GateResult {
  const evidence: Record<string, string | undefined> = {};
  const manifest: Record<string, { path: string; sha256: string; bytes: number }> = {};
  const freshness: Record<string, Freshness> = {};
  const cur = opts?.cwd ? fingerprint(opts.cwd) : null;
  for (const key of requiredKeys) {
    const p = join(evidenceDir, `${key}.md`);
    if (!existsSync(p)) {
      evidence[key] = undefined; // → "missing"
      freshness[key] = "unknown";
      continue;
    }
    const content = readFileSync(p, "utf-8");
    evidence[key] = content;
    freshness[key] = freshnessOf(parseMarker(content), cur ?? { head: null, tree: null });
    manifest[key] = {
      path: p,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    };
  }
  const base = scoreWorkProduct({ required_keys: requiredKeys }, evidence, "strict");
  const stale = requiredKeys.filter((k) => freshness[k] === "stale" && base.scorecard[k] === "ok");
  const verdict = opts?.strict && stale.length > 0 ? "BLOCK" : base.verdict;
  return {
    verdict,
    scorecard: base.scorecard,
    freshness,
    missing: Object.entries(base.scorecard)
      .filter(([, s]) => s !== "ok")
      .map(([k]) => k),
    manifest,
  };
}

// Human default: verdict line + padded per-key table (scorecard × freshness).
// The sha256 manifest stays machine-only — it is noise in a terminal and the
// whole point of --json.
export function renderGate(result: {
  verdict: GateResult["verdict"];
  scorecard: GateResult["scorecard"];
  freshness: GateResult["freshness"];
}): string {
  const keys = Object.keys(result.scorecard);
  const verdict = result.verdict === "MERGE" ? "PASS" : "BLOCK";
  if (keys.length === 0) return `VERDICT: ${verdict}\n(no required evidence keys)`;
  const keyW = Math.max("key".length, ...keys.map((k) => k.length));
  const stateW = Math.max("state".length, ...keys.map((k) => result.scorecard[k].length));
  const lines = [
    `VERDICT: ${verdict}`,
    "",
    `${"key".padEnd(keyW)}  ${"state".padEnd(stateW)}  freshness`,
    ...keys.map((k) => `${k.padEnd(keyW)}  ${result.scorecard[k].padEnd(stateW)}  ${result.freshness[k] ?? "unknown"}`),
  ];
  return lines.join("\n");
}

export function registerGateCommand(cli: CAC) {
  cli
    .command("gate [file]", "Deterministic evidence gate: MERGE/BLOCK over required evidence keys")
    .example("$ gk gate                 # gate the active graph's evidence")
    .example("$ gk gate path/to/graph.yaml --json")
    .option("--json", "JSON output")
    .action((file, opts: { json?: boolean }) => {
      try {
        const resolved = file ?? join(process.cwd(), "graph.yaml");
        const graph = loadGraph(resolved);
        const findings = validateGraph(graph, process.cwd());
        if (findings.length > 0) {
          if (opts.json) {
            console.log(JSON.stringify(fail("VALIDATION_FAILED", "graph has findings", { findings })));
          } else {
            console.log(`✗ VALIDATION_FAILED — ${findings.length} finding(s)`);
            console.log(renderFindings(findings));
          }
          process.exit(1);
          return;
        }
        const evidenceDir = join(process.cwd(), graph.outputs.evidence_dir);
        const { verdict, scorecard, freshness, missing, manifest } = gateGraph(
          graph.evidence.required_keys,
          evidenceDir,
          {
            cwd: process.cwd(),
            strict: graph.evidence.freshness === "strict",
          },
        );
        const stale = Object.keys(freshness).filter((k) => freshness[k] === "stale" && scorecard[k] === "ok");
        if (verdict !== "MERGE") {
          // A block is a failure — exit 1 either way. Human mode gets the same
          // verdict table as a merge plus the concrete repair path; --json
          // keeps the full machine envelope (scripts parse it for `missing`).
          if (opts.json) {
            console.log(
              JSON.stringify(
                fail("GATE_BLOCK", "evidence gate blocked merge", { missing, stale, scorecard, freshness, manifest }),
              ),
            );
          } else {
            const lines = [renderGate({ verdict, scorecard, freshness })];
            if (missing.length > 0) {
              lines.push(
                "",
                `Missing: ${missing.join(", ")} — produce ${graph.outputs.evidence_dir}<key>.md, then rerun \`gk gate\``,
              );
            }
            console.log(lines.join("\n"));
          }
          process.exit(1);
          return;
        }
        console.log(
          opts.json
            ? JSON.stringify(ok({ verdict, scorecard, freshness, manifest }))
            : renderGate({ verdict, scorecard, freshness }),
        );
      } catch (e) {
        console.log(
          JSON.stringify(
            e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("GATE_ERROR", String(e)),
          ),
        );
        process.exit(1);
      }
    });
}
