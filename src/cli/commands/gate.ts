import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CAC } from "cac";
import { validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import { scoreWorkProduct } from "../../eval/rubrics.js";
import { fail, ok } from "../output.js";
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
  missing: string[];
  manifest: Record<string, { path: string; sha256: string; bytes: number }>;
}

export function gateGraph(requiredKeys: string[], evidenceDir: string): GateResult {
  const evidence: Record<string, string | undefined> = {};
  const manifest: Record<string, { path: string; sha256: string; bytes: number }> = {};
  for (const key of requiredKeys) {
    const p = join(evidenceDir, `${key}.md`);
    if (!existsSync(p)) {
      evidence[key] = undefined; // → "missing"
      continue;
    }
    const content = readFileSync(p, "utf-8");
    evidence[key] = content;
    manifest[key] = {
      path: p,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    };
  }
  const { verdict, scorecard } = scoreWorkProduct({ required_keys: requiredKeys }, evidence, "strict");
  return {
    verdict,
    scorecard,
    missing: Object.entries(scorecard)
      .filter(([, s]) => s !== "ok")
      .map(([k]) => k),
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
        if (findings.length > 0) {
          console.log(JSON.stringify(fail("VALIDATION_FAILED", "graph has findings", { findings })));
          process.exit(1);
          return;
        }
        const evidenceDir = join(process.cwd(), graph.outputs.evidence_dir);
        const { verdict, scorecard, missing, manifest } = gateGraph(graph.evidence.required_keys, evidenceDir);
        if (verdict === "MERGE") {
          console.log(JSON.stringify(ok({ verdict, scorecard, manifest })));
          return;
        }
        console.log(
          JSON.stringify(fail("GATE_BLOCK", "evidence gate blocked merge", { missing, scorecard, manifest })),
        );
        process.exit(1);
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
