# Memory Retrieval Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build retrieval debugging for GraphKit's memory layer with an explain engine (`explainRecall`), dual renderers (ASCII terminal table + standalone interactive HTML), and an append-only runtime recall capture log.

**Architecture:** A pure explain engine computes scored hits, filter verdicts, and outranked documents without mutating state or triggering `touchMemory`. Two renderers consume this structured output: an ASCII renderer for the terminal and an HTML renderer outputting Archify-styled reports in `.graphkit/diagrams/`. Runtime recalls log execution metadata to `.graphkit/memory/.recall-log.jsonl` to compare historical planned vs. actual retrievals.

**Tech Stack:** TypeScript, Node.js stdlib (`fs`, `path`, `crypto`), Bun test runner.

## Global Constraints

- Never call `touchMemory` during `--explain` operations.
- Zero external runtime dependencies or servers.
- Preserve 100% backward-compatibility for non-explain `gk memory recall` output.
- Follow existing Archify theme palette for dark/light HTML mode.
- All code must pass `bun run lint` and `bun test`.

---

### Task 1: Explain Engine Core (`explainRecall`)

**Files:**
- Create: `src/memory/explain-recall.ts`
- Test: `test/memory-explain.test.ts`

**Interfaces:**
- Consumes: `loadMemories`, `applyRecallFilters`, `dropInvalid`, `resolveSuperseded`, `MemoryDoc` from `src/eval/memory-recall.js`, `readLinks` from `src/memory/links.js`
- Produces: `explainRecall(memDir: string, query: string, k?: number, now?: string): RecallExplanation`, and types `RecallExplanation`, `DocExplain`, `ExplainDocStatus`, `ExplainRejectReason`

- [ ] **Step 1: Write the failing unit tests for `explainRecall`**

Create `test/memory-explain.test.ts`:
```ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { explainRecall } from "../src/memory/explain-recall.js";

const TEST_DIR = join(process.cwd(), ".tmp-test-explain-memory");

describe("explainRecall", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("classifies direct hits, expired, superseded, and outranked docs", () => {
    // 1. Valid hit
    writeFileSync(
      join(TEST_DIR, "hit.md"),
      `---\nid: mem-hit\nsalience: 0.8\nstatus: stable\n---\nAuth token refresh workflow.`,
    );

    // 2. Expired doc
    writeFileSync(
      join(TEST_DIR, "expired.md"),
      `---\nid: mem-exp\nsalience: 0.9\nvalid_to: 2026-01-01T00:00:00Z\n---\nAuth token refresh legacy.`,
    );

    // 3. Superseded doc
    writeFileSync(
      join(TEST_DIR, "old.md"),
      `---\nid: mem-old\nsalience: 0.9\nsuperseded_by: mem-hit\n---\nAuth token refresh old.`,
    );

    // 4. Low salience outranked doc
    writeFileSync(
      join(TEST_DIR, "low.md"),
      `---\nid: mem-low\nsalience: 0.1\nstatus: stable\n---\nAuth token background.`,
    );

    const explanation = explainRecall(TEST_DIR, "auth token refresh", 1, "2026-09-10T00:00:00Z");

    expect(explanation.query).toBe("auth token refresh");
    expect(explanation.query_terms).toEqual(["auth", "token", "refresh"]);
    expect(explanation.hits.length).toBe(1);
    expect(explanation.hits[0].id).toBe("mem-hit");
    expect(explanation.hits[0].status).toBe("hit");
    expect(explanation.hits[0].raw_salience).toBe(0.8);
    expect(explanation.hits[0].final_score).toBeCloseTo(3 * 0.8, 5); // 3 terms * 0.8

    // Check rejected candidates
    const expDoc = explanation.rejected_top_n.find((d) => d.id === "mem-exp");
    expect(expDoc).toBeDefined();
    expect(expDoc?.status).toBe("filtered");
    expect(expDoc?.reason).toBe("expired");

    const oldDoc = explanation.rejected_top_n.find((d) => d.id === "mem-old");
    expect(oldDoc).toBeDefined();
    expect(oldDoc?.status).toBe("filtered");
    expect(oldDoc?.reason).toBe("superseded");
    expect(oldDoc?.superseded_by).toBe("mem-hit");

    const lowDoc = explanation.rejected_top_n.find((d) => d.id === "mem-low");
    expect(lowDoc).toBeDefined();
    expect(lowDoc?.status).toBe("rejected");
    expect(lowDoc?.reason).toBe("outranked");
  });

  it("applies 0.5x penalty to link-expanded neighbors", () => {
    writeFileSync(
      join(TEST_DIR, "root.md"),
      `---\nid: mem-root\nsalience: 0.8\nstatus: stable\n---\nDatabase connection pool configuration.`,
    );
    writeFileSync(
      join(TEST_DIR, "neighbor.md"),
      `---\nid: mem-neighbor\nsalience: 0.6\nstatus: stable\n---\nQuery timeout tuning.`,
    );
    writeFileSync(
      join(TEST_DIR, ".links.json"),
      JSON.stringify({
        generated_at: "2026-09-10T00:00:00Z",
        links: {
          "mem-root": ["mem-neighbor"],
        },
      }),
    );

    const explanation = explainRecall(TEST_DIR, "database connection", 2, "2026-09-10T00:00:00Z");
    expect(explanation.hits.length).toBe(2);
    expect(explanation.hits[0].id).toBe("mem-root");
    expect(explanation.hits[0].linked_via).toBeUndefined();

    expect(explanation.hits[1].id).toBe("mem-neighbor");
    expect(explanation.hits[1].linked_via).toBe("mem-root");
    expect(explanation.hits[1].linked_penalty).toBe(0.5);
    expect(explanation.hits[1].final_score).toBeCloseTo(0.6 * 0.5, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory-explain.test.ts`
Expected: FAIL with "Cannot find module '../src/memory/explain-recall.js'"

- [ ] **Step 3: Implement `explainRecall` in `src/memory/explain-recall.ts`**

```ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  dropInvalid,
  loadMemories,
  type MemoryDoc,
  resolveSuperseded,
} from "../eval/memory-recall.js";
import { readLinks } from "./links.js";

export type ExplainDocStatus = "hit" | "filtered" | "rejected";

export type ExplainRejectReason =
  | "zero_overlap"
  | "expired"
  | "not_yet_valid"
  | "superseded"
  | "outranked";

export interface DocExplain {
  id: string;
  file: string;
  matched_terms: string[];
  raw_salience: number;
  final_score: number;
  status: ExplainDocStatus;
  reason?: ExplainRejectReason;
  superseded_by?: string;
  linked_via?: string;
  linked_penalty?: number;
}

export interface RecallExplanation {
  query: string;
  query_terms: string[];
  now: string;
  k: number;
  scanned_count: number;
  malformed_count: number;
  hits: DocExplain[];
  rejected_top_n: DocExplain[];
}

const LINK_PENALTY = 0.5;

function recallDirs(memDir: string): Array<{ dir: string; prefix: string }> {
  if (!existsSync(memDir)) return [];
  const dirs = [{ dir: memDir, prefix: "" }];
  for (const de of readdirSync(memDir, { withFileTypes: true })) {
    if (de.isDirectory() && !de.name.startsWith(".")) {
      dirs.push({ dir: join(memDir, de.name), prefix: `${de.name}/` });
    }
  }
  return dirs;
}

export function explainRecall(
  memDir: string,
  query: string,
  k = 5,
  now = new Date().toISOString(),
): RecallExplanation {
  const docs: MemoryDoc[] = [];
  const where = new Map<string, string>();

  for (const { dir, prefix } of recallDirs(memDir)) {
    for (const d of loadMemories(dir)) {
      docs.push(d);
      where.set(d.id, prefix + d.file);
    }
  }

  const qTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  // Score docs based on query term overlap
  const scored = docs.map((doc) => {
    const matched = qTerms.filter((t) => doc.terms.has(t));
    const score = matched.length * doc.salience;
    return { doc, matched, score };
  });

  // Track validity drops
  const validMap = new Map(dropInvalid(docs, now).map((d) => [d.id, d]));
  const resolvedMap = new Map(resolveSuperseded(Array.from(validMap.values())).map((d) => [d.id, d]));

  // Sort overlapping docs descending by score
  const overlapping = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const directHits: DocExplain[] = [];
  const rejectedOrFiltered: DocExplain[] = [];

  for (const item of overlapping) {
    const { doc, matched, score } = item;
    const relFile = where.get(doc.id) ?? doc.file;

    // Check expiry / validity
    if (!validMap.has(doc.id)) {
      rejectedOrFiltered.push({
        id: doc.id,
        file: relFile,
        matched_terms: matched,
        raw_salience: doc.salience,
        final_score: score,
        status: "filtered",
        reason: "expired",
      });
      continue;
    }

    // Check supersede
    if (!resolvedMap.has(doc.id)) {
      rejectedOrFiltered.push({
        id: doc.id,
        file: relFile,
        matched_terms: matched,
        raw_salience: doc.salience,
        final_score: score,
        status: "filtered",
        reason: "superseded",
        superseded_by: doc.superseded_by,
      });
      continue;
    }

    // Survives filters
    if (directHits.length < k) {
      directHits.push({
        id: doc.id,
        file: relFile,
        matched_terms: matched,
        raw_salience: doc.salience,
        final_score: score,
        status: "hit",
      });
    } else {
      rejectedOrFiltered.push({
        id: doc.id,
        file: relFile,
        matched_terms: matched,
        raw_salience: doc.salience,
        final_score: score,
        status: "rejected",
        reason: "outranked",
      });
    }
  }

  // Link expansion for leftover slots
  const graph = readLinks(memDir);
  const seen = new Set(directHits.map((h) => h.id));
  const hits = [...directHits];

  if (hits.length < k) {
    outer: for (const hit of directHits) {
      for (const neighborId of graph.links[hit.id] ?? []) {
        if (seen.has(neighborId)) continue;
        const neighborDoc = docs.find((d) => d.id === neighborId);
        if (!neighborDoc) continue;
        if (hits.length >= k) break outer;

        const relFile = where.get(neighborDoc.id) ?? neighborDoc.file;
        const neighborMatched = qTerms.filter((t) => neighborDoc.terms.has(t));
        const penalizedScore = neighborDoc.salience * LINK_PENALTY;

        hits.push({
          id: neighborDoc.id,
          file: relFile,
          matched_terms: neighborMatched,
          raw_salience: neighborDoc.salience,
          final_score: penalizedScore,
          status: "hit",
          linked_via: hit.id,
          linked_penalty: LINK_PENALTY,
        });
        seen.add(neighborId);
      }
    }
  }

  // Zero-overlap docs that are high salience can be added to rejected if needed
  const zeroOverlap = scored
    .filter((s) => s.score === 0)
    .sort((a, b) => b.doc.salience - a.doc.salience);

  for (const item of zeroOverlap) {
    if (rejectedOrFiltered.length >= 10) break;
    rejectedOrFiltered.push({
      id: item.doc.id,
      file: where.get(item.doc.id) ?? item.doc.file,
      matched_terms: [],
      raw_salience: item.doc.salience,
      final_score: 0,
      status: "rejected",
      reason: "zero_overlap",
    });
  }

  return {
    query,
    query_terms: qTerms,
    now,
    k,
    scanned_count: docs.length,
    malformed_count: 0,
    hits,
    rejected_top_n: rejectedOrFiltered.slice(0, 5),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory-explain.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/explain-recall.ts test/memory-explain.test.ts
git commit -m "feat(memory): implement deterministic explainRecall engine"
```

---

### Task 2: ASCII & HTML Renderers (`render-recall.ts`)

**Files:**
- Create: `src/memory/render-recall.ts`
- Modify: `test/memory-explain.test.ts`

**Interfaces:**
- Consumes: `RecallExplanation`, `DocExplain` from `src/memory/explain-recall.js`
- Produces: `renderRecallAscii(explanation: RecallExplanation): string`, `renderRecallHtml(explanation: RecallExplanation, historyLogs?: any[]): string`

- [ ] **Step 1: Write failing tests for renderers**

Add to `test/memory-explain.test.ts`:
```ts
import { renderRecallAscii, renderRecallHtml } from "../src/memory/render-recall.js";

describe("renderRecall", () => {
  const sampleExplanation = {
    query: "auth token expiry",
    query_terms: ["auth", "token", "expiry"],
    now: "2026-09-10T14:00:00Z",
    k: 3,
    scanned_count: 15,
    malformed_count: 0,
    hits: [
      {
        id: "mem-a1b2",
        file: "knowledge/token-ttl.md",
        matched_terms: ["auth", "token", "expiry"],
        raw_salience: 0.14,
        final_score: 0.42,
        status: "hit" as const,
      },
      {
        id: "mem-e5f6",
        file: "suggestions/renewal.md",
        matched_terms: ["expiry"],
        raw_salience: 0.07,
        final_score: 0.035,
        status: "hit" as const,
        linked_via: "mem-a1b2",
        linked_penalty: 0.5,
      },
    ],
    rejected_top_n: [
      {
        id: "mem-9a8b",
        file: "legacy/token.md",
        matched_terms: ["auth", "token"],
        raw_salience: 0.1,
        final_score: 0.2,
        status: "filtered" as const,
        reason: "superseded" as const,
        superseded_by: "mem-a1b2",
      },
      {
        id: "mem-7c6d",
        file: "old.md",
        matched_terms: ["auth"],
        raw_salience: 0.05,
        final_score: 0.05,
        status: "filtered" as const,
        reason: "expired" as const,
      },
    ],
  };

  it("renders expected ASCII table layout", () => {
    const ascii = renderRecallAscii(sampleExplanation);
    expect(ascii).toContain('recall: "auth token expiry"');
    expect(ascii).toContain("HITS");
    expect(ascii).toContain("mem-a1b2");
    expect(ascii).toContain("0.035*");
    expect(ascii).toContain("linked via mem-a1b2");
    expect(ascii).toContain("REJECTED");
    expect(ascii).toContain("superseded by mem-a1b2");
  });

  it("renders standalone self-contained HTML page", () => {
    const html = renderRecallHtml(sampleExplanation);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("auth token expiry");
    expect(html).toContain("knowledge/token-ttl.md");
    expect(html).toContain("mem-a1b2");
    expect(html).toContain("Archify");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory-explain.test.ts`
Expected: FAIL with missing exports in `render-recall.js`

- [ ] **Step 3: Implement `renderRecallAscii` and `renderRecallHtml` in `src/memory/render-recall.ts`**

```ts
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

export function renderRecallHtml(exp: RecallExplanation, historyLogs: any[] = []): string {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory-explain.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/render-recall.ts test/memory-explain.test.ts
git commit -m "feat(memory): add ASCII and standalone HTML renderers for recall explanation"
```

---

### Task 3: CLI Integration & Capture Logging (`src/cli/commands/memory.ts`)

**Files:**
- Modify: `src/cli/commands/memory.ts`
- Test: `test/cli-memory-explain.test.ts`

**Interfaces:**
- CLI flags added: `--explain`, `--html`, `--origin <origin>`
- Writes: `.graphkit/memory/.recall-log.jsonl` (when NOT `--explain`), `.graphkit/diagrams/recall-<slug>.html` (when `--explain --html`)

- [ ] **Step 1: Write integration tests in `test/cli-memory-explain.test.ts`**

```ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const CWD = join(process.cwd(), ".tmp-test-cli-explain");

describe("gk memory recall CLI explain options", () => {
  beforeEach(() => {
    rmSync(CWD, { recursive: true, force: true });
    mkdirSync(join(CWD, ".graphkit", "memory"), { recursive: true });

    writeFileSync(
      join(CWD, ".graphkit", "memory", "auth.md"),
      `---\nid: mem-auth\nsalience: 0.9\nstatus: stable\n---\nJWT token verification protocol.`,
    );
  });

  afterEach(() => {
    rmSync(CWD, { recursive: true, force: true });
  });

  it("runs --explain and emits ASCII table without appending to .recall-log.jsonl", async () => {
    const out = await $`bun run src/index.ts memory recall "JWT token" --explain`.cwd(CWD).text();
    expect(out).toContain('recall: "JWT token"');
    expect(out).toContain("mem-auth");

    // Explain mode must NOT append to .recall-log.jsonl
    expect(existsSync(join(CWD, ".graphkit", "memory", ".recall-log.jsonl"))).toBe(false);
  });

  it("appends to .recall-log.jsonl on standard recall", async () => {
    await $`bun run src/index.ts memory recall "JWT token" --origin curator`.cwd(CWD).quiet();
    const logPath = join(CWD, ".graphkit", "memory", ".recall-log.jsonl");
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, "utf-8");
    const entry = JSON.parse(content.trim().split("\n")[0]);
    expect(entry.query).toBe("JWT token");
    expect(entry.origin).toBe("curator");
    expect(entry.hits[0].id).toBe("mem-auth");
  });

  it("generates HTML file when --explain --html is passed", async () => {
    const out = await $`bun run src/index.ts memory recall "JWT token" --explain --html`.cwd(CWD).text();
    expect(out).toContain(".graphkit/diagrams/");
    const match = out.match(/\.graphkit\/diagrams\/recall-[^\s]+\.html/);
    expect(match).not.toBeNull();
    const htmlPath = join(CWD, match![0]);
    expect(existsSync(htmlPath)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli-memory-explain.test.ts`
Expected: FAIL (options not yet recognized / no explain branch)

- [ ] **Step 3: Update `src/cli/commands/memory.ts`**

Update `registerMemoryCommands`:
- Add options:
  - `.option("--explain", "Explain recall scoring and filter decisions")`
  - `.option("--html", "Render explain visualization as standalone HTML")`
  - `.option("--origin <origin>", "Origin marker for recall log (e.g. cli, curator, agent)")`
- In `subcommand === "recall"` branch:
  - If `opts.explain`:
    - Call `explainRecall(memDir, query, topk)`.
    - If `opts.json`: print JSON.
    - If `opts.html`:
      - Call `renderRecallHtml(explanation)`.
      - Write to `.graphkit/diagrams/recall-${slug}.html`.
      - Print relative file path.
    - Else:
      - Call `renderRecallAscii(explanation)`.
      - Print to stdout.
    - Return without touching memories or appending to recall log.
  - If NOT `opts.explain`:
    - Perform existing `expandedRecall`, `touchMemory`.
    - Append `{ ts, query, k, origin, hits, scanned }` to `.graphkit/memory/.recall-log.jsonl`.
    - Output standard JSON as before.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/cli-memory-explain.test.ts`
Expected: PASS

- [ ] **Step 5: Run full lint and all tests**

Run: `bun run lint && bun test`
Expected: All 575+ tests pass; lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/memory.ts test/cli-memory-explain.test.ts
git commit -m "feat(memory): wire --explain, --html, and recall-log to gk memory recall"
```

---

### Task 4: Documentation & Command Inventory Updates

**Files:**
- Modify: `README.md`
- Modify: `src/cli/command-registry.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update `command-registry.ts` to include `--explain` and `--html` options**

Modify `src/cli/command-registry.ts` under `memory recall` entry:
Add `"--explain"`, `"--html"`, `"--origin <origin>"` to `options`.

- [ ] **Step 2: Add recall debugging examples to `README.md`**

In the "Cross-session project memory" section:
```bash
# Debug why a memory ranked or was filtered out:
gk memory recall "database migration" --explain

# Generate interactive HTML recall diagnosis:
gk memory recall "database migration" --explain --html
```

- [ ] **Step 3: Update `CHANGELOG.md` under `[Unreleased]`**

Add feature note:
```markdown
- `gk memory recall <query> --explain`: deterministic retrieval debugging showing query term overlap, salience math, link penalties (0.5×), and filter/rejection verdicts (`expired`, `superseded`, `outranked`). Add `--html` to generate an interactive Archify-styled report in `.graphkit/diagrams/`.
- Runtime recall logging: non-explain recalls append execution metadata to `.graphkit/memory/.recall-log.jsonl` with `--origin` tagging for planned-vs-actual comparison.
```

- [ ] **Step 4: Run verification**

Run: `bun run lint && bun run check-changelog`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md src/cli/command-registry.ts CHANGELOG.md
git commit -m "docs(memory): document memory recall explain and visualization features"
```
