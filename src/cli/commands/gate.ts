import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CAC } from "cac";
import { isBlocking, validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import { scoreWorkProduct } from "../../eval/rubrics.js";
import { fingerprint } from "../../evidence/fingerprint.js";
import { type Freshness, freshnessOf, parseMarker } from "../../evidence/marker.js";
import { featureListPath, readFeatureList } from "../../features/store.js";
import { activeRun, readRunIndex, readTrace } from "../../runs/ledger.js";
import { resumeChain } from "../../runs/resume.js";
import { previewGraph } from "../graph-resolve.js";
import { emit, fail, ok } from "../output.js";

/**
 * Deterministic evidence gate: MERGE/BLOCK over required evidence keys.
 *
 * Evidence key → file contract (ADR-002): required key `k` maps to
 * `<evidenceDir>/<k>.md`; satisfied iff the file exists and is non-empty
 * after trim (exactly `scoreWorkProduct` strict semantics). The basename is
 * the only deterministic, zero-parser mapping — no manifest or heading
 * parsing is trusted.
 */

export interface CriterionScore {
  id: string;
  weight: number;
  status: "ok" | "missing" | "empty";
  freshness: Freshness;
  passed: boolean;
  contribution: number;
}

export interface GateResult {
  verdict: "MERGE" | "BLOCK";
  scorecard: Record<string, "ok" | "missing" | "empty">;
  freshness: Record<string, Freshness>;
  missing: string[];
  warnings: string[];
  unlanded: string[];
  manifest: Record<string, { path: string; sha256: string; bytes: number }>;
  /** Feature-list gate verdict — present only when the graph declares
   *  features.required. "missing"/"invalid" states also block: a required
   *  backlog that doesn't exist or can't be parsed can't be all-passed. */
  features?: {
    required: true;
    path: string;
    state: "ok" | "missing" | "invalid";
    total: number;
    done: number;
    open: number;
    open_items: string[];
  };
  /** Machine-readable block reasons — "FEATURES_OPEN:n" when open feature
   *  items hold the gate, "FEATURE_LIST_MISSING"/"FEATURE_LIST_INVALID" when
   *  a required list can't be read. */
  reasons: string[];
  // Present only under evidence.verdict: "scored".
  score?: number;
  threshold?: number;
  per_criterion?: CriterionScore[];
}

export interface ScoredGate {
  criteria: { id: string; weight: number }[];
  threshold: number;
}

export function gateGraph(
  requiredKeys: string[],
  evidenceDir: string,
  opts?: {
    cwd?: string;
    strict?: boolean;
    requireLanded?: boolean;
    scored?: ScoredGate;
    features?: { required: boolean; path?: string };
  },
): GateResult {
  const evidence: Record<string, string | undefined> = {};
  const manifest: Record<string, { path: string; sha256: string; bytes: number }> = {};
  const freshness: Record<string, Freshness> = {};
  const cur = opts?.cwd ? fingerprint(opts.cwd) : null;
  // Lineage scope (GAP-3): active run + its `resumes:` ancestors. Evidence stamped
  // by a run outside it is foreign; with no active run the check is skipped so the
  // gate stays usable on fresh checkouts.
  const activeDir = opts?.cwd ? activeRun(opts.cwd) : null;
  const lineage = opts?.cwd && activeDir ? resumeChain(opts.cwd, basename(activeDir)) : null;
  // Scored gates evaluate the criteria on top of required_keys — union both
  // lists so every scored id gets a real exists/non-empty/freshness reading.
  const checkKeys = opts?.scored
    ? [...new Set([...requiredKeys, ...opts.scored.criteria.map((c) => c.id)])]
    : requiredKeys;
  for (const key of checkKeys) {
    const p = join(evidenceDir, `${key}.md`);
    if (!existsSync(p)) {
      evidence[key] = undefined; // → "missing"
      freshness[key] = "unknown";
      continue;
    }
    const content = readFileSync(p, "utf-8");
    const marker = parseMarker(content);
    evidence[key] = marker?.superseded ? undefined : content; // superseded → "missing"
    freshness[key] =
      lineage && marker?.run_id && !lineage.has(marker.run_id)
        ? "foreign" // stamped by an unrelated run; run_id:null (legacy/hand-written) never foreign
        : freshnessOf(marker, cur ?? { head: null, tree: null });
    manifest[key] = {
      path: p,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    };
  }
  const base = scoreWorkProduct({ required_keys: checkKeys }, evidence, "strict");
  const stale = requiredKeys.filter((k) => freshness[k] === "stale" && base.scorecard[k] === "ok");
  const unknown = requiredKeys.filter((k) => freshness[k] === "unknown" && base.scorecard[k] === "ok");
  const foreign = requiredKeys.filter((k) => freshness[k] === "foreign" && base.scorecard[k] === "ok");
  const warnings: string[] = [];
  if (foreign.length > 0)
    warnings.push(
      `evidence stamped by a run outside the active run's resumes chain: ${foreign.join(", ")} — re-stamp via \`gk evidence add\` inside the active run`,
    );
  if (opts?.strict && unknown.length > 0)
    warnings.push(
      `unstamped evidence (no fingerprint marker) treated as failing under strict freshness: ${unknown.join(", ")} — write evidence via \`gk evidence add\``,
    );
  const unlanded: string[] = [];
  if (opts?.requireLanded && opts.cwd) {
    const id = activeRun(opts.cwd) ? basename(activeRun(opts.cwd)!) : readRunIndex(opts.cwd).at(-1)?.id;
    if (id) {
      // Landed is an append-only event: one landed line covers every ok line
      // before it for that node. Scan newest-first — an ok line carrying
      // required evidence with no landed event after it leaves its node open.
      const covered = new Set<string>();
      const open = new Set<string>();
      const trace = readTrace(opts.cwd, id);
      for (let i = trace.length - 1; i >= 0; i--) {
        const t = trace[i];
        if (t.status === "landed") covered.add(t.node);
        else if (t.status === "ok" && t.evidence.some((e) => requiredKeys.includes(e)) && !covered.has(t.node))
          open.add(t.node);
      }
      unlanded.push(...[...open].reverse());
    }
  }
  const reasons: string[] = [];
  let features: GateResult["features"];
  if (opts?.features?.required && opts.cwd) {
    const path = featureListPath(opts.cwd, { features: opts.features });
    try {
      const list = readFeatureList(path);
      const openItems = list.items.filter((i) => !i.passes).map((i) => i.id);
      features = {
        required: true,
        path,
        state: "ok",
        total: list.items.length,
        done: list.items.length - openItems.length,
        open: openItems.length,
        open_items: openItems,
      };
      if (openItems.length > 0) reasons.push(`FEATURES_OPEN:${openItems.length}`);
    } catch (e) {
      const state = e instanceof GraphKitError && e.code === "FEATURE_LIST_INVALID" ? "invalid" : "missing";
      features = { required: true, path, state, total: 0, done: 0, open: 0, open_items: [] };
      reasons.push(state === "invalid" ? "FEATURE_LIST_INVALID" : "FEATURE_LIST_MISSING");
    }
  }
  // required_keys remain a hard floor in every verdict mode: a scored gate can
  // never merge while a declared required key fails, evidence is unlanded, or
  // a required feature list is open/missing.
  const floor =
    (opts?.strict && (stale.length > 0 || unknown.length > 0 || foreign.length > 0)) ||
    unlanded.length > 0 ||
    reasons.length > 0
      ? "BLOCK"
      : requiredKeys.every((k) => base.scorecard[k] === "ok")
        ? "MERGE"
        : "BLOCK";
  let score: number | undefined;
  let per_criterion: CriterionScore[] | undefined;
  if (opts?.scored) {
    // Same pass rules as the binary gate, per criterion: exists + non-empty,
    // plus fresh under freshness: strict (report mode never fails on freshness,
    // mirroring the floor). A failing criterion contributes 0 to the numerator
    // but keeps its weight in the denominator.
    per_criterion = opts.scored.criteria.map((c) => {
      const status = base.scorecard[c.id] ?? "missing";
      const passed = status === "ok" && (!opts.strict || freshness[c.id] === "fresh");
      return {
        id: c.id,
        weight: c.weight,
        status,
        freshness: freshness[c.id] ?? "unknown",
        passed,
        contribution: passed ? c.weight : 0,
      };
    });
    const total = opts.scored.criteria.reduce((s, c) => s + c.weight, 0);
    score = total > 0 ? per_criterion.reduce((s, c) => s + c.contribution, 0) / total : 0;
  }
  const verdict = floor === "MERGE" && (!opts?.scored || (score ?? 0) >= opts.scored.threshold) ? "MERGE" : "BLOCK";
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
    ...(features ? { features } : {}),
    reasons,
    score,
    threshold: opts?.scored?.threshold,
    per_criterion,
  };
}

export function registerGateCommand(cli: CAC) {
  cli
    .command("gate [file]", "Deterministic evidence gate: MERGE/BLOCK over required evidence keys")
    .option("--json", "JSON output")
    .action((file) => {
      try {
        const graph = previewGraph(process.cwd(), file).graph;
        const findings = validateGraph(graph, process.cwd());
        if (findings.some(isBlocking)) {
          emit(fail("VALIDATION_FAILED", "graph has findings", { issues: findings }));
          return;
        }
        const evidenceDir = join(process.cwd(), graph.outputs.evidence_dir);
        // Scored verdict: bare criteria ids score as weight 1. threshold is
        // guaranteed by validate (scored-threshold); the ?? 1 fallback is the
        // conservative reading if the gate is ever driven around validation.
        const scored =
          graph.evidence.verdict === "scored"
            ? {
                criteria: (graph.evidence.criteria ?? []).map((c) =>
                  typeof c === "string" ? { id: c, weight: 1 } : c,
                ),
                threshold: graph.evidence.threshold ?? 1,
              }
            : undefined;
        const {
          verdict,
          scorecard,
          freshness,
          missing,
          warnings,
          unlanded,
          manifest,
          score,
          threshold,
          per_criterion,
          features,
          reasons,
        } = gateGraph(graph.evidence.required_keys, evidenceDir, {
          cwd: process.cwd(),
          strict: graph.evidence.freshness === "strict",
          requireLanded: graph.evidence.require_landed === true,
          scored,
          features: graph.features,
        });
        const stale = Object.keys(freshness).filter((k) => freshness[k] === "stale" && scorecard[k] === "ok");
        const foreign = Object.keys(freshness).filter((k) => freshness[k] === "foreign" && scorecard[k] === "ok");
        const scoredFields = scored
          ? {
              score,
              threshold,
              per_criterion,
              summary: `SCORE ${(score ?? 0).toFixed(2)} ${(score ?? 0) >= (threshold ?? 1) ? ">=" : "<"} ${(threshold ?? 1).toFixed(2)} → ${verdict}`,
            }
          : {};
        if (verdict === "MERGE") {
          emit(
            ok({
              verdict,
              scorecard,
              freshness,
              warnings,
              unlanded,
              manifest,
              ...(features ? { features } : {}),
              ...scoredFields,
            }),
          );
          return;
        }
        emit(
          fail("GATE_BLOCK", "evidence gate blocked merge", {
            missing,
            foreign,
            stale,
            warnings,
            unlanded,
            scorecard,
            freshness,
            manifest,
            reasons,
            ...(features ? { features } : {}),
            ...scoredFields,
          }),
        );
      } catch (e) {
        emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("GATE_ERROR", String(e)));
      }
    });
}
