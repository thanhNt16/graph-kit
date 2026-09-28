import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CAC } from "cac";
import { isBlocking, validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import { scoreWorkProduct } from "../../eval/rubrics.js";
import { fingerprint } from "../../evidence/fingerprint.js";
import { type Freshness, freshnessOf, parseMarker } from "../../evidence/marker.js";
import { activeRun, readRunIndex, readTrace } from "../../memory/ledger.js";
import { emit, fail, ok } from "../output.js";
import { loadGraph } from "./graph.js";

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
  warnings: string[];
  unlanded: string[];
  manifest: Record<string, { path: string; sha256: string; bytes: number }>;
}

export function gateGraph(
  requiredKeys: string[],
  evidenceDir: string,
  opts?: { cwd?: string; strict?: boolean; requireLanded?: boolean },
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
    const marker = parseMarker(content);
    evidence[key] = marker?.superseded ? undefined : content; // superseded → "missing"
    freshness[key] = freshnessOf(marker, cur ?? { head: null, tree: null });
    manifest[key] = {
      path: p,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    };
  }
  const base = scoreWorkProduct({ required_keys: requiredKeys }, evidence, "strict");
  const stale = requiredKeys.filter((k) => freshness[k] === "stale" && base.scorecard[k] === "ok");
  const unknown = requiredKeys.filter((k) => freshness[k] === "unknown" && base.scorecard[k] === "ok");
  const warnings =
    opts?.strict && unknown.length > 0
      ? [
          `unstamped evidence (no fingerprint marker) treated as failing under strict freshness: ${unknown.join(", ")} — write evidence via \`gk evidence add\``,
        ]
      : [];
  const unlanded: string[] = [];
  if (opts?.requireLanded && opts.cwd) {
    const id = activeRun(opts.cwd) ? basename(activeRun(opts.cwd)!) : readRunIndex(opts.cwd).at(-1)?.id;
    if (id)
      for (const t of readTrace(opts.cwd, id))
        if (
          t.status === "ok" &&
          !t.landed &&
          t.evidence.some((e) => requiredKeys.includes(e)) &&
          !unlanded.includes(t.node)
        )
          unlanded.push(t.node);
  }
  const verdict =
    (opts?.strict && (stale.length > 0 || unknown.length > 0)) || unlanded.length > 0 ? "BLOCK" : base.verdict;
  return {
    verdict,
    scorecard: base.scorecard,
    freshness,
    missing: Object.entries(base.scorecard)
      .filter(([, s]) => s !== "ok")
      .map(([k]) => k),
    warnings,
    unlanded,
    manifest,
  };
}

export function registerGateCommand(cli: CAC) {
  cli
    .command("gate [file]", "Deterministic evidence gate: MERGE/BLOCK over required evidence keys")
    .option("--json", "JSON output")
    .action((file) => {
      try {
        const resolved = file ?? join(process.cwd(), "graph.yaml");
        const graph = loadGraph(resolved);
        const findings = validateGraph(graph, process.cwd());
        if (findings.some(isBlocking)) {
          emit(fail("VALIDATION_FAILED", "graph has findings", { findings }));
          return;
        }
        const evidenceDir = join(process.cwd(), graph.outputs.evidence_dir);
        const { verdict, scorecard, freshness, missing, warnings, unlanded, manifest } = gateGraph(
          graph.evidence.required_keys,
          evidenceDir,
          {
            cwd: process.cwd(),
            strict: graph.evidence.freshness === "strict",
            requireLanded: graph.evidence.require_landed === true,
          },
        );
        const stale = Object.keys(freshness).filter((k) => freshness[k] === "stale" && scorecard[k] === "ok");
        if (verdict === "MERGE") {
          emit(ok({ verdict, scorecard, freshness, warnings, unlanded, manifest }));
          return;
        }
        emit(
          fail("GATE_BLOCK", "evidence gate blocked merge", {
            missing,
            stale,
            warnings,
            unlanded,
            scorecard,
            freshness,
            manifest,
          }),
        );
      } catch (e) {
        emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("GATE_ERROR", String(e)));
      }
    });
}
