import { RELATIVE_CUTOFF } from "../eval/memory-recall.js";
import type { RecallExplanation } from "./explain-recall.js";

function escapeHtml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderRecallAscii(exp: RecallExplanation): string {
  const lines: string[] = [];
  lines.push(
    `recall: "${exp.query}"   k=${exp.k}   scanned=${exp.scanned_count}   terms=[${exp.query_terms.join(", ")}]`,
  );
  lines.push("");

  if (exp.hits.length === 0) {
    lines.push("HITS: none");
  } else {
    lines.push("HITS");
    lines.push(" #  score   sal   terms                 id          file");
    exp.hits.forEach((h, idx) => {
      const num = String(idx + 1).padStart(2, " ");
      const scoreStr = (h.linked_via ? `${h.final_score.toFixed(3)}*` : h.final_score.toFixed(2)).padEnd(7, " ");
      const salStr = h.raw_salience.toFixed(2).padEnd(5, " ");
      const termsStr = (h.matched_terms.join(", ") || "(none)").padEnd(21, " ");
      const idStr = h.id.padEnd(11, " ");
      let fileStr = h.file;
      if (h.linked_via) {
        fileStr += `   ← linked via ${h.linked_via} (ppr ${(h.ppr_mass ?? 0).toFixed(2)})`;
      }
      lines.push(`${num}  ${scoreStr} ${salStr} ${termsStr} ${idStr} ${fileStr}`);
    });
  }

  lines.push("");
  if (exp.rejected_top_n.length > 0) {
    lines.push(`REJECTED (top ${exp.rejected_top_n.length})`);
    for (const r of exp.rejected_top_n) {
      const idStr = r.id.padEnd(10, " ");
      let statusStr = "REJECTED";
      let detail = r.reason ?? "";

      switch (r.reason) {
        case "superseded":
          statusStr = "FILTERED";
          detail = r.superseded_by ? `superseded by ${r.superseded_by}` : "superseded";
          break;
        case "expired":
        case "not_yet_valid":
          statusStr = "FILTERED";
          detail = r.reason;
          break;
        case "below_cutoff":
          statusStr = "BELOW_CUTOFF";
          detail = `score ${r.final_score.toFixed(3)} is a distractor (< ${RELATIVE_CUTOFF} × top hit)`;
          break;
        case "outranked":
          statusStr = "OUTRANKED";
          detail = `score ${r.final_score.toFixed(3)} < top-k`;
          break;
        case "zero_overlap":
          statusStr = "ZERO_OVERLAP";
          detail = "no term overlap with query";
          break;
      }
      lines.push(`  ${idStr} ${statusStr.padEnd(13, " ")} ${detail}`);
    }
  }

  return lines.join("\n");
}

export function renderRecallHtml(exp: RecallExplanation): string {
  const maxScore = Math.max(1, ...exp.hits.map((h) => h.final_score));

  const hitsHtml = exp.hits
    .map((h, i) => {
      const widthPct = Math.min(100, Math.round((h.final_score / maxScore) * 100));
      const badge = h.linked_via
        ? `<span class="badge linked">linked via ${escapeHtml(h.linked_via)} (ppr ${(h.ppr_mass ?? 0).toFixed(2)})</span>`
        : `<span class="badge hit">direct match</span>`;

      return `
      <div class="hit-card ${h.linked_via ? "linked-card" : ""}">
        <div class="hit-header">
          <span class="rank">#${i + 1}</span>
          <span class="hit-id">${escapeHtml(h.id)}</span>
          <span class="hit-file">${escapeHtml(h.file)}</span>
          ${badge}
          <span class="score-label">Score: <strong>${h.final_score.toFixed(3)}</strong> (sal: ${h.raw_salience.toFixed(2)})</span>
        </div>
        <div class="score-bar-bg">
          <div class="score-bar-fill" style="width: ${widthPct}%;"></div>
        </div>
        <div class="matched-terms">
          Matched terms: ${h.matched_terms.map((t) => `<span class="term-tag">${escapeHtml(t)}</span>`).join(" ") || "<em>none</em>"}
        </div>
      </div>`;
    })
    .join("\n");

  const rejectedHtml = exp.rejected_top_n
    .map((r) => {
      let detail = escapeHtml(r.reason ?? "");
      if (r.reason === "superseded" && r.superseded_by) {
        detail = `superseded by <code>${escapeHtml(r.superseded_by)}</code>`;
      } else if (r.reason === "below_cutoff") {
        detail = `score ${r.final_score.toFixed(3)} is a distractor (&lt; ${RELATIVE_CUTOFF} × top hit)`;
      } else if (r.reason === "outranked") {
        detail = `score ${r.final_score.toFixed(3)} &lt; top-k`;
      } else if (r.reason === "zero_overlap") {
        detail = "no term overlap with query";
      }
      return `
      <tr>
        <td><code>${escapeHtml(r.id)}</code></td>
        <td>${escapeHtml(r.file)}</td>
        <td><span class="badge ${escapeHtml(r.status)}">${escapeHtml(r.status.toUpperCase())}</span></td>
        <td>${detail}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Memory Recall Explain — ${escapeHtml(exp.query)}</title>
  <meta name="generator" content="GraphKit Archify">
  <style>
    :root {
      --bg: #020617;
      --card-bg: #0f172a;
      --border: #1e293b;
      --text: #ffffff;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-bar: #34d399;
      --linked-bar: #a78bfa;
      --score-bg: #1e293b;
      --warn: #fbbf24;
      --err: #fb7185;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --card-bg: #ffffff;
        --border: #e2e8f0;
        --text: #0f172a;
        --text-muted: #64748b;
        --accent: #0284c7;
        --accent-bar: #059669;
        --linked-bar: #7c3aed;
        --score-bg: #e2e8f0;
        --warn: #d97706;
        --err: #e11d48;
      }
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 24px;
    }
    .container { max-width: 960px; margin: 0 auto; }
    h1 { margin-top: 0; font-size: 1.5rem; color: var(--text); }
    h2 { color: var(--text); }
    .meta { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 24px; }
    .hit-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .linked-card { border-style: dashed; }
    .hit-header { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; font-size: 0.95rem; }
    .rank { font-weight: bold; color: var(--accent); }
    .hit-id { font-family: monospace; color: var(--text); }
    .hit-file { color: var(--text-muted); font-size: 0.85rem; }
    .score-label { margin-left: auto; font-family: monospace; }
    .score-bar-bg { background: var(--score-bg); border-radius: 4px; height: 8px; width: 100%; margin: 8px 0; overflow: hidden; }
    .score-bar-fill { background: var(--accent-bar); height: 100%; }
    .linked-card .score-bar-fill { background: var(--linked-bar); }
    .matched-terms { font-size: 0.85rem; color: var(--text-muted); margin-top: 4px; }
    .term-tag { background: rgba(56, 189, 248, 0.15); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.35); padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    .badge { font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; font-weight: bold; }
    .badge.hit { background: rgba(52, 211, 153, 0.15); color: var(--accent-bar); border: 1px solid rgba(52, 211, 153, 0.35); }
    .badge.linked { background: rgba(167, 139, 250, 0.15); color: var(--linked-bar); border: 1px solid rgba(167, 139, 250, 0.35); }
    .badge.filtered { background: rgba(251, 113, 133, 0.15); color: var(--err); border: 1px solid rgba(251, 113, 133, 0.35); }
    .badge.rejected { background: rgba(251, 191, 36, 0.15); color: var(--warn); border: 1px solid rgba(251, 191, 36, 0.35); }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.9rem; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); }
    th { color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="container">
    <h1>Memory Recall Diagnosis</h1>
    <div class="meta">
      Query: <strong>"${escapeHtml(exp.query)}"</strong> | Top-K: ${exp.k} | Scanned: ${exp.scanned_count} docs | Time: ${escapeHtml(exp.now)}
    </div>

    <h2>Hits</h2>
    ${hitsHtml || "<p>No hits for this query.</p>"}

    ${
      exp.rejected_top_n.length > 0
        ? `<h2>Rejected Candidates</h2>
    <table>
      <thead>
        <tr><th>ID</th><th>File</th><th>Verdict</th><th>Reason</th></tr>
      </thead>
      <tbody>
        ${rejectedHtml}
      </tbody>
    </table>`
        : ""
    }
  </div>
</body>
</html>`;
}
