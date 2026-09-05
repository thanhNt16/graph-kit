import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Graph } from "../compiler/validate.js";
import { loadCriteria } from "./criteria.js";
import { fingerprint } from "./fingerprint.js";
import { type Freshness, freshnessOf, parseMarker } from "./marker.js";

export interface CriterionView {
  id: string;
  description: string | null;
  kind: "report" | "screenshot" | "json" | "metrics" | "text";
  status: "present" | "missing";
  freshness: Freshness;
  artifact: string | null;
  provenance: string | null;
}

const BADGE = { present: "● present", missing: "○ missing" } as const;
const FRESH_TAG: Record<Freshness, string> = { fresh: "", stale: " · ◐ stale", unknown: " · ? unknown" };

export function buildViews(cwd: string, graph: Graph): CriterionView[] {
  const criteria = loadCriteria(cwd, graph.evidence.criteria ?? []);
  const evDir = join(cwd, graph.outputs.evidence_dir);
  const cur = fingerprint(cwd);
  return graph.evidence.required_keys.map((id) => {
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
      status: content.trim().length > 0 ? ("present" as const) : ("missing" as const),
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

export function renderMarkdown(name: string, views: CriterionView[]): string {
  const lines = [`# Evidence — ${name}`, ""];
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

export function renderHtml(name: string, views: CriterionView[], evidenceDir: string): string {
  const cards: string[] = [];
  for (const v of views) {
    const badge = v.status === "present" ? "&#9679; present" : "&#9675; missing";
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
    `<style>body{font-family:system-ui;margin:2rem;max-width:60rem}.card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}.stale{color:#b45309}.unknown{color:#6b7280}pre{background:#f6f8fa;padding:.5rem;overflow:auto}img{max-width:100%}footer{color:#6b7280;font-size:.8rem;margin-top:.5rem}</style>` +
    `</head><body><h1>Evidence — ${escapeHtml(name)}</h1>${cards.join("")}</body></html>`
  );
}
