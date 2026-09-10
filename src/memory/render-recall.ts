import type { RecallExplanation } from "./explain-recall.js";

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
        fileStr += `   ← linked via ${h.linked_via} (${h.linked_penalty ?? 0.5}x)`;
      }
      lines.push(`${num}  ${scoreStr} ${salStr} ${termsStr} ${idStr} ${fileStr}`);
    });
  }

  lines.push("");
  if (exp.rejected_top_n.length > 0) {
    lines.push(`REJECTED (top ${exp.rejected_top_n.length})`);
    for (const r of exp.rejected_top_n) {
      const idStr = r.id.padEnd(10, " ");
      const statusStr = (r.status === "filtered" ? "FILTERED" : "OUTRANKED").padEnd(10, " ");
      let detail = r.reason ?? "";
      if (r.reason === "superseded" && r.superseded_by) {
        detail = `superseded by ${r.superseded_by}`;
      } else if (r.reason === "outranked") {
        detail = `score ${r.final_score.toFixed(3)} < cutoff`;
      }
      lines.push(`  ${idStr} ${statusStr} ${detail}`);
    }
  }

  return lines.join("\n");
}

export function renderRecallHtml(exp: RecallExplanation, historyLogs: unknown[] = []): string {
  const maxScore = Math.max(1, ...exp.hits.map((h) => h.final_score));

  const hitsHtml = exp.hits
    .map((h, i) => {
      const widthPct = Math.min(100, Math.round((h.final_score / maxScore) * 100));
      const badge = h.linked_via
        ? `<span class="badge linked">linked via ${h.linked_via} (0.5x)</span>`
        : `<span class="badge hit">direct match</span>`;

      return `
      <div class="hit-card ${h.linked_via ? "linked-card" : ""}">
        <div class="hit-header">
          <span class="rank">#${i + 1}</span>
          <span class="hit-id">${h.id}</span>
          <span class="hit-file">${h.file}</span>
          ${badge}
          <span class="score-label">Score: <strong>${h.final_score.toFixed(3)}</strong> (sal: ${h.raw_salience.toFixed(2)})</span>
        </div>
        <div class="score-bar-bg">
          <div class="score-bar-fill" style="width: ${widthPct}%;"></div>
        </div>
        <div class="matched-terms">
          Matched terms: ${h.matched_terms.map((t) => `<span class="term-tag">${t}</span>`).join(" ") || "<em>none</em>"}
        </div>
      </div>`;
    })
    .join("\n");

  const rejectedHtml = exp.rejected_top_n
    .map((r) => {
      let detail = r.reason ?? "";
      if (r.reason === "superseded" && r.superseded_by) {
        detail = `superseded by <code>${r.superseded_by}</code>`;
      }
      return `
      <tr>
        <td><code>${r.id}</code></td>
        <td>${r.file}</td>
        <td><span class="badge ${r.status}">${r.status.toUpperCase()}</span></td>
        <td>${detail}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Memory Recall Explain — ${exp.query}</title>
  <meta name="generator" content="GraphKit Archify">
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --accent: #58a6ff;
      --accent-bar: #238636;
      --linked-bar: #8957e5;
      --warn: #d29922;
      --err: #f85149;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 24px;
    }
    .container { max-width: 960px; margin: 0 auto; }
    h1 { margin-top: 0; font-size: 1.5rem; color: #fff; }
    .meta { color: #8b949e; font-size: 0.9rem; margin-bottom: 24px; }
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
    .hit-id { font-family: monospace; color: #fff; }
    .hit-file { color: #8b949e; font-size: 0.85rem; }
    .score-label { margin-left: auto; font-family: monospace; }
    .score-bar-bg { background: #21262d; border-radius: 4px; height: 8px; width: 100%; margin: 8px 0; overflow: hidden; }
    .score-bar-fill { background: var(--accent-bar); height: 100%; }
    .linked-card .score-bar-fill { background: var(--linked-bar); }
    .matched-terms { font-size: 0.85rem; color: #8b949e; margin-top: 4px; }
    .term-tag { background: #1f6feb33; color: var(--accent); border: 1px solid #1f6feb66; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    .badge { font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; font-weight: bold; }
    .badge.hit { background: #23863633; color: #3fb950; border: 1px solid #23863666; }
    .badge.linked { background: #8957e533; color: #bc8cff; border: 1px solid #8957e566; }
    .badge.filtered { background: #f8514933; color: var(--err); border: 1px solid #f8514966; }
    .badge.rejected { background: #d2992233; color: var(--warn); border: 1px solid #d2992266; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.9rem; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); }
    th { color: #8b949e; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Memory Recall Diagnosis</h1>
    <div class="meta">
      Query: <strong>"${exp.query}"</strong> | Top-K: ${exp.k} | Scanned: ${exp.scanned_count} docs | Time: ${exp.now}
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
