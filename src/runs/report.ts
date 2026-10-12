/** End-of-run HTML report: `gk run report <id> --html` writes a
 *  self-contained page to `.graphkit/reports/<id>-run.html`, and `gk run end`
 *  writes one automatically so every closed run leaves a reviewable record.
 *  Pure readers over the run dir + evidence dir — no model calls, works
 *  offline, safe to regenerate any time. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadGraphDoc } from "../cli/graph-resolve.js";
import { buildViews, scoreViews } from "../evidence/report.js";
import { readAllProposals, readVerdicts } from "../learn/learn.js";
import { type BudgetStatus, budgetStatus } from "./budget.js";
import {
  type DispatchLine,
  isNodeLine,
  type RunIndexLine,
  readAdvisorEvents,
  readDispatches,
  readProgress,
  readRunIndex,
  readRunMeta,
  readTrace,
  type TraceEntry,
  verifyTraceChain,
} from "./ledger.js";

export interface RunReport {
  run: RunIndexLine & { graph_path?: string };
  meta: { started_at: string; budget?: { max_tokens: number; warn_at: number } };
  budget: BudgetStatus | null;
  trace: TraceEntry[];
  dispatches: DispatchLine[];
  advisor_events: { node: string; round: number; streak: number | null }[];
  evidence: ReturnType<typeof buildViews> | null;
  score: ReturnType<typeof scoreViews>;
  progress: string[];
  learn: { at: string; proposal: string; action: string; verdict: string }[];
  chain: { ok: boolean; chained: number; legacy: number };
}

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Assemble everything the report needs. Missing pieces degrade to
 *  null/empty rather than erroring — a report for a damaged run dir should
 *  still say what it can. */
export function buildRunReport(cwd: string, runId: string): RunReport {
  const meta = readRunMeta(cwd, runId);
  const idx = readRunIndex(cwd).find((r) => r.id === runId);
  const trace = existsSync(join(cwd, ".graphkit", "runs", runId, "trace.jsonl")) ? readTrace(cwd, runId) : [];
  const nodes = trace.filter(isNodeLine);
  const summary: RunIndexLine = idx ?? {
    id: runId,
    graph: meta.graph,
    graph_sha256: meta.graph_sha256,
    started_at: meta.started_at,
    ended_at: meta.ended_at ?? "(running)",
    status: "blocked",
    node_count: nodes.length,
    failures: nodes.filter((t) => t.status === "fail").length,
    evidence_keys: [...new Set(nodes.flatMap((t) => t.evidence))].sort(),
  };

  let evidence = null;
  let score = null;
  if (existsSync(meta.graph_path)) {
    try {
      const doc = loadGraphDoc(meta.graph_path);
      if (doc.kind === "graph") {
        evidence = buildViews(cwd, doc.graph);
        score = scoreViews(cwd, doc.graph, evidence);
      }
    } catch {
      /* graph unreadable — evidence section degrades to the ledger's keys */
    }
  }

  const proposals = new Map(readAllProposals(cwd).map((p) => [p.id, p.source_run]));
  const learn = readVerdicts(cwd)
    .filter((v) => proposals.get(v.proposal) === runId || v.proposal.startsWith(`promote-${runId}`))
    .map(({ at, proposal, action, verdict }) => ({ at, proposal, action, verdict }));

  let chainOk = false;
  let chained = 0;
  let legacy = 0;
  try {
    const v = verifyTraceChain(cwd, runId);
    chainOk = v.ok;
    chained = v.chained_lines;
    legacy = v.legacy_lines;
  } catch {
    /* no trace — chain block renders as unavailable */
  }

  return {
    run: { ...summary, graph_path: meta.graph_path },
    meta: { started_at: meta.started_at, budget: meta.budget },
    budget: meta.budget ? budgetStatus(cwd, runId, meta) : null,
    trace,
    dispatches: readDispatches(cwd, runId),
    advisor_events: readAdvisorEvents(cwd, runId),
    evidence,
    score,
    progress: (readProgress(cwd, runId) ?? "")
      .split("\n")
      .filter((l) => l.startsWith("- ["))
      .slice(-20),
    learn,
    chain: { ok: chainOk, chained, legacy },
  };
}

export function renderRunHtml(r: RunReport): string {
  const statusColor = r.run.status === "merged" ? "#1a7f37" : r.run.status === "failed" ? "#cf222e" : "#bf8700";
  const nodeRows = r.trace
    .map((t) => {
      if (isNodeLine(t)) {
        const s = t.status === "ok" ? "ok" : t.status;
        return `<tr><td>${esc(t.at)}</td><td>${esc(t.node)}</td><td>${t.wave ?? ""}</td><td>${esc(s)}</td><td>${esc(t.evidence.join(", "))}</td><td>${esc(t.agent ?? "")}</td><td>${esc(t.notes ?? "")}</td></tr>`;
      }
      return `<tr><td>${esc(t.at)}</td><td>${esc(t.node)}</td><td></td><td>landed</td><td colspan="2">commit ${esc(t.commit.slice(0, 12))}</td><td></td></tr>`;
    })
    .join("");
  const evRows = (r.evidence ?? [])
    .map(
      (v) =>
        `<tr><td>${esc(v.id)}</td><td>${esc(v.status)}</td><td>${esc(v.freshness)}</td><td>${esc(v.artifact ?? "")}</td><td>${esc(v.provenance ?? "")}</td></tr>`,
    )
    .join("");
  const learnRows = r.learn
    .map(
      (l) =>
        `<tr><td>${esc(l.at)}</td><td>${esc(l.proposal)}</td><td>${esc(l.action)}</td><td>${esc(l.verdict)}</td></tr>`,
    )
    .join("");
  const dispatchRows = r.dispatches
    .map((d) => `<tr><td>${esc(d.at)}</td><td>${esc(d.node)}</td><td>${esc(d.via)}</td><td>${d.pid ?? ""}</td></tr>`)
    .join("");
  const advisorRows = r.advisor_events
    .map((a) => `<tr><td>${esc(a.node)}</td><td>round ${a.round}</td><td>streak ${a.streak ?? "—"}</td></tr>`)
    .join("");

  const section = (title: string, body: string) =>
    body ? `<section class="card"><h2>${title}</h2>${body}</section>` : "";
  const table = (head: string, rows: string) =>
    rows ? `<table><thead>${head}</thead><tbody>${rows}</tbody></table>` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Run report — ${esc(r.run.id)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:2rem auto;max-width:64rem;padding:0 1rem;color:#1f2328;line-height:1.5}
h1{font-size:1.4rem}h2{font-size:1rem;margin-top:0}
.card{border:1px solid #d0d7de;border-radius:8px;padding:1rem;margin:1rem 0}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0}
dt{color:#57606a}dd{margin:0;font-family:ui-monospace,monospace;font-size:.9em}
table{border-collapse:collapse;width:100%;font-size:.85rem}
td,th{border:1px solid #d0d7de;padding:.3rem .6rem;text-align:left;vertical-align:top}
th{background:#f6f8fa}
.status{font-weight:600;color:${statusColor}}
.badge{display:inline-block;border:1px solid #d0d7de;border-radius:1rem;padding:.1rem .6rem;font-size:.8rem;margin-left:.5rem}
pre{background:#f6f8fa;padding:.75rem;overflow:auto;font-size:.8rem;border-radius:6px}
@media(prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}.card,td,th{border-color:#30363d}th,pre{background:#161b22}dt{color:#7d8590}}
</style></head><body>
<h1>Run report <span class="badge">${esc(r.run.id)}</span></h1>
<section class="card"><h2>Summary</h2><dl>
<dt>status</dt><dd class="status">${esc(r.run.status)}</dd>
<dt>graph</dt><dd>${esc(r.run.graph)}</dd>
<dt>started</dt><dd>${esc(r.run.started_at)}</dd>
<dt>ended</dt><dd>${esc(r.run.ended_at)}</dd>
<dt>nodes</dt><dd>${r.run.node_count} (${r.run.failures} failed)</dd>
<dt>evidence keys</dt><dd>${esc(r.run.evidence_keys.join(", ") || "—")}</dd>
${r.budget ? `<dt>budget</dt><dd>${r.budget.allocated}/${r.budget.max} declared tokens${r.budget.exceeded ? " — EXCEEDED" : ""}</dd>` : ""}
<dt>ledger integrity</dt><dd>${r.chain.chained + r.chain.legacy === 0 ? "no trace lines" : `${r.chain.ok ? "verified" : "CHAIN BROKEN"} — ${r.chain.chained} chained, ${r.chain.legacy} legacy`}</dd>
</dl></section>
${section("Timeline", table("<tr><th>at</th><th>node</th><th>wave</th><th>status</th><th>evidence</th><th>agent</th><th>notes</th></tr>", nodeRows))}
${section("Dispatches", table("<tr><th>at</th><th>node</th><th>via</th><th>pid</th></tr>", dispatchRows))}
${section("Evidence scorecard", (r.score ? `<p><strong>score ${r.score.score.toFixed(2)} / threshold ${r.score.threshold.toFixed(2)} → ${esc(r.score.verdict)}</strong></p>` : "") + table("<tr><th>key</th><th>status</th><th>freshness</th><th>artifact</th><th>provenance</th></tr>", evRows))}
${section("Advisor events", table("<tr><th>node</th><th>round</th><th>streak</th></tr>", advisorRows))}
${section("Learning verdicts", table("<tr><th>at</th><th>proposal</th><th>action</th><th>verdict</th></tr>", learnRows))}
${section("Progress log (last 20)", `<pre>${esc(r.progress.join("\n"))}</pre>`)}
<footer style="color:#57606a;font-size:.8rem;margin:2rem 0">Generated by gk run report — graphkit-gk. Self-contained; no external requests.</footer>
</body></html>`;
}

/** Write the report and return its path. Advisory: callers should not let a
 *  render failure block the run lifecycle. */
export function writeRunReport(cwd: string, runId: string): string {
  const out = join(cwd, ".graphkit", "reports", `${runId}-run.html`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderRunHtml(buildRunReport(cwd, runId)));
  return out;
}
