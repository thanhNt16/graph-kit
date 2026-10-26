import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { featureListPath, readFeatureList } from "../features/store.js";
import type { Graph } from "../schemas/graph.schema.js";
import { criterionId, criterionWeight, loadCriteria } from "./criteria.js";
import { fingerprint } from "./fingerprint.js";
import { type Freshness, freshnessOf, parseMarker } from "./marker.js";

export interface CriterionView {
  id: string;
  description: string | null;
  kind: "report" | "screenshot" | "json" | "metrics" | "text";
  status: "present" | "missing" | "superseded";
  freshness: Freshness;
  artifact: string | null;
  provenance: string | null;
}

const BADGE = { present: "● present", missing: "○ missing", superseded: "◌ superseded" } as const;
// ponytail: gate-only state today — buildViews never emits `foreign`; entry keeps the Record exhaustive.
const FRESH_TAG: Record<Freshness, string> = {
  fresh: "",
  stale: " · ◐ stale",
  unknown: " · ? unknown",
  foreign: " · ⚠ foreign",
};

export function buildViews(cwd: string, graph: Graph): CriterionView[] {
  const criteria = loadCriteria(cwd, graph.evidence.criteria ?? []);
  const evDir = join(cwd, graph.outputs.evidence_dir);
  const cur = fingerprint(cwd);
  // Scored gates evaluate criteria that may be produced-but-not-required —
  // union both lists so every scored id gets a row. Binary reports keep their
  // exact required_keys shape.
  const ids =
    graph.evidence.verdict === "scored"
      ? [...new Set([...graph.evidence.required_keys, ...(graph.evidence.criteria ?? []).map(criterionId)])]
      : graph.evidence.required_keys;
  return ids.map((id) => {
    const c = criteria.get(id) ?? null;
    const p = join(evDir, `${id}.md`);
    if (!existsSync(p)) {
      return {
        id,
        description: c?.description || null,
        kind: c?.kind ?? "report",
        status: "missing" as const,
        freshness: "unknown" as Freshness,
        artifact: null,
        provenance: null,
      };
    }
    const content = readFileSync(p, "utf-8");
    const m = parseMarker(content);
    return {
      id,
      description: c?.description || null,
      kind: c?.kind ?? "report",
      // Gate parity (audit F-01): a superseded marker ≡ missing for gating
      // (gate.ts scores it "missing") — label it distinctly instead of
      // reporting present.
      status: m?.superseded
        ? ("superseded" as const)
        : content.trim().length > 0
          ? ("present" as const)
          : ("missing" as const),
      freshness: freshnessOf(m, cur),
      artifact: m?.artifact ?? null,
      provenance: m
        ? [m.run_id && `run ${m.run_id}`, m.node && `node ${m.node}`, m.fingerprint_head?.slice(0, 8), m.ts]
            .filter(Boolean)
            .join(" · ") || null
        : null,
    };
  });
}

/** Gate-score summary for `verdict: scored` graphs — same pass rule as
 * gate.ts (present + fresh under strict freshness), computed over views. */
export interface ScoreView {
  verdict: "MERGE" | "BLOCK";
  score: number;
  threshold: number;
  /** Why the hard floor blocked even when the score met threshold — same
   *  floor gk gate applies: required keys must pass (fresh under strict) and
   *  a required feature list must be complete. Empty when the floor passes. */
  floor_reasons: string[];
  per_criterion: {
    id: string;
    weight: number;
    status: CriterionView["status"];
    passed: boolean;
    contribution: number;
  }[];
}

export function scoreViews(cwd: string, graph: Graph, views: CriterionView[]): ScoreView | null {
  if (graph.evidence.verdict !== "scored") return null;
  const strict = graph.evidence.freshness === "strict";
  const byId = new Map(views.map((v) => [v.id, v]));
  const per_criterion = (graph.evidence.criteria ?? []).map((c) => {
    const id = criterionId(c);
    const weight = criterionWeight(c);
    const v = byId.get(id);
    const passed = v?.status === "present" && (!strict || v.freshness === "fresh");
    return {
      id,
      weight,
      status: v?.status ?? ("missing" as const),
      passed,
      contribution: passed ? weight : 0,
    };
  });
  const total = per_criterion.reduce((s, c) => s + c.weight, 0);
  const score = total > 0 ? per_criterion.reduce((s, c) => s + c.contribution, 0) / total : 0;
  const threshold = graph.evidence.threshold ?? 1;
  // The score can never merge over a broken floor — same conditions gk gate
  // checks before it even looks at the weighted criteria.
  const floor_reasons: string[] = [];
  for (const k of graph.evidence.required_keys) {
    const v = byId.get(k);
    if (v?.status !== "present") floor_reasons.push(`required key ${k}: ${v?.status ?? "missing"}`);
    else if (strict && v.freshness !== "fresh") floor_reasons.push(`required key ${k}: ${v.freshness}`);
  }
  if (graph.features?.required) {
    try {
      const open = readFeatureList(featureListPath(cwd, { features: graph.features })).items.filter((i) => !i.passes);
      if (open.length > 0) floor_reasons.push(`FEATURES_OPEN:${open.length}`);
    } catch {
      floor_reasons.push("FEATURE_LIST_MISSING");
    }
  }
  const verdict = floor_reasons.length === 0 && score >= threshold ? "MERGE" : "BLOCK";
  return { verdict, score, threshold, floor_reasons, per_criterion };
}

export function renderMarkdown(name: string, views: CriterionView[], score?: ScoreView | null): string {
  const lines = [`# Evidence — ${name}`, ""];
  if (score) {
    lines.push(`## Gate score`, "");
    lines.push(
      `**SCORE ${score.score.toFixed(2)} ${score.score >= score.threshold ? ">=" : "<"} ${score.threshold.toFixed(2)} → ${score.verdict}**`,
      ...(score.floor_reasons.length > 0 ? ["", `Floor blocked: ${score.floor_reasons.join(", ")}`] : []),
      "",
    );
    lines.push(`| criterion | weight | pass | contribution |`, `| --- | --- | --- | --- |`);
    for (const c of score.per_criterion) {
      lines.push(`| ${c.id} | ${c.weight} | ${c.passed ? "pass" : "fail"} | ${c.contribution} |`);
    }
    lines.push("");
  }
  for (const v of views) {
    lines.push(`## ${v.id}`);
    if (v.description) lines.push(`> ${v.description}`);
    lines.push(`- Status: ${BADGE[v.status]}${FRESH_TAG[v.freshness]}`);
    if (v.artifact) lines.push(`- Artifact: ${v.artifact}`);
    if (v.provenance) lines.push(`- Provenance: ${v.provenance}`);
    lines.push("");
  }
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function artifactAbs(evidenceDir: string, rel: string | null): string | null {
  if (!rel) return null;
  const p = join(evidenceDir, rel);
  return existsSync(p) ? p : null;
}

export function renderHtml(
  name: string,
  views: CriterionView[],
  evidenceDir: string,
  score?: ScoreView | null,
): string {
  const cards: string[] = [];
  if (score) {
    const rows = score.per_criterion
      .map(
        (c) =>
          `<tr><td>${escapeHtml(c.id)}</td><td>${escapeHtml(String(c.weight))}</td><td>${c.passed ? "pass" : "fail"}</td><td>${escapeHtml(String(c.contribution))}</td></tr>`,
      )
      .join("");
    cards.push(
      `<section class="card score"><h2>Gate score</h2>` +
        `<p><strong>SCORE ${escapeHtml(score.score.toFixed(2))} ${score.score >= score.threshold ? "&gt;=" : "&lt;"} ${escapeHtml(score.threshold.toFixed(2))} → ${escapeHtml(score.verdict)}</strong></p>` +
        (score.floor_reasons.length > 0
          ? `<p class="floor">Floor blocked: ${escapeHtml(score.floor_reasons.join(", "))}</p>`
          : "") +
        `<table><thead><tr><th>criterion</th><th>weight</th><th>pass</th><th>contribution</th></tr></thead><tbody>${rows}</tbody></table></section>`,
    );
  }
  for (const v of views) {
    const badge = BADGE[v.status];
    const fresh =
      v.freshness === "stale"
        ? ' <span class="stale">&#9682; stale</span>'
        : v.freshness === "unknown"
          ? ' <span class="unknown">? unknown</span>'
          : "";
    let body = "";
    const abs = artifactAbs(evidenceDir, v.artifact);
    if (abs && v.status === "present") {
      const lower = abs.toLowerCase();
      if (v.kind === "screenshot" && !lower.endsWith(".svg")) {
        body = `<img src="data:image/${lower.endsWith(".png") ? "png" : "jpeg"};base64,${readFileSync(abs).toString("base64")}" alt="${escapeHtml(v.id)}">`;
      } else if (v.kind === "screenshot") {
        body = `<p><a href="${escapeHtml(v.artifact!)}">download ${escapeHtml(v.artifact!)}</a></p>`;
      } else {
        let text = readFileSync(abs, "utf-8");
        if (v.kind === "json") {
          try {
            text = JSON.stringify(JSON.parse(text), null, 2);
          } catch {
            // raw content on parse failure
          }
        }
        body = `<pre>${escapeHtml(text)}</pre>`;
      }
    }
    if (!body && v.artifact) body = `<p><a href="${escapeHtml(v.artifact)}">download ${escapeHtml(v.artifact)}</a></p>`;
    cards.push(
      `<section class="card"><h2>${escapeHtml(v.id)} <small>${badge}${fresh}</small></h2>` +
        (v.description ? `<p class="desc">${escapeHtml(v.description)}</p>` : "") +
        body +
        (v.provenance ? `<footer>${escapeHtml(v.provenance)}</footer>` : "") +
        `</section>`,
    );
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Evidence — ${escapeHtml(name)}</title>` +
    `<style>body{font-family:system-ui;margin:2rem;max-width:60rem}.card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}.stale{color:#b45309}.unknown{color:#6b7280}pre{background:#f6f8fa;padding:.5rem;overflow:auto}img{max-width:100%}footer{color:#6b7280;font-size:.8rem;margin-top:.5rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.25rem .75rem;text-align:left}</style>` +
    `</head><body><h1>Evidence — ${escapeHtml(name)}</h1>${cards.join("")}</body></html>`
  );
}
