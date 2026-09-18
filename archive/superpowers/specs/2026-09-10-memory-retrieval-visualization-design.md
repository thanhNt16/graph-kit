# Memory Retrieval Visualization Design

**Status:** Proposed  
**Author:** GraphKit Team  
**Date:** 2026-09-10  
**Target:** `src/memory/explain-recall.ts`, `src/cli/commands/memory.ts`, `src/memory/render-recall.ts`

## 1. Context & Motivation

GraphKit uses an ACT-R-inspired memory layer under `.graphkit/memory/`. At runtime, `gk memory recall "<query>"` retrieves contextual memories through a frozen, deterministic algorithm:
1. Extract query tokens (> 2 characters).
2. Compute raw overlap score: `match_count * doc.salience`.
3. Filter invalid memories (`dropInvalid`: expired, not-yet-valid, past `valid_to`).
4. Resolve supersession (`resolveSuperseded`: replace head with latest successor).
5. Link expansion (`expandedRecall`): neighbors in `.links.json` fill remaining `top_k` slots with a `0.5×` penalty.
6. Touch retrieved memories (`touchMemory`: bump `use_count`, update `last_used_at`).

### The Developer Problem
When an agent acts on outdated context or fails to use an authored rule, developers cannot see *why*. The memory store appears opaque:
- Did the query match zero terms?
- Was the rule filtered out because of an expiry timestamp or a missing successor in a supersession chain?
- Was the memory outranked by higher-salience docs?
- Did a neighbor pull it in via link expansion?

This design adds **retrieval debugging visualization** across two surfaces: terminal ASCII (default) and standalone interactive HTML (`--html`), powered by an explain engine and an append-only recall capture log.

---

## 2. Goals & Non-Goals

### Goals
- **Deterministic Explain Engine:** Re-run retrieval on demand without side effects (no `touchMemory` increment), breaking down term matches, salience multiplication, filter drops, and link penalties.
- **Surface Negative Space:** Explicitly show why top rejected/filtered memories did not make the `top_k` cut (e.g. `FILTERED: superseded by mem-xyz`, `FILTERED: expired`, `OUTRANKED`).
- **Dual Presentation:** ASCII table in the terminal by default (`--explain`), standalone Archify-style HTML with `--html` for shareable reports.
- **Recall Capture Log:** Record actual runtime recall events (from CLI and curator) into `.graphkit/memory/.recall-log.jsonl` to enable planned vs. actual comparison.
- **Zero Heavy Dependencies:** Implemented with pure standard library / existing repo utilities; no headless browser or external visualization servers.

### Non-Goals
- Real-time HTTP dashboard daemon (`gk memory --serve`).
- Full force-directed store network graph (deferred to separate store-health tool).
- Modifying the underlying frozen retrieval math or decay scoring formulas.

---

## 3. Data Contracts & Architecture

### 3.1 Explain Engine Output Contract (`RecallExplanation`)

```ts
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
  linked_via?: string; // id of direct hit that pulled this doc in
  linked_penalty?: number; // 0.5 if link-expanded
}

export interface RecallExplanation {
  query: string;
  query_terms: string[];
  now: string;
  k: number;
  scanned_count: number;
  malformed_count: number;
  hits: DocExplain[];
  rejected_top_n: DocExplain[]; // top 5 most relevant rejected/filtered items
}
```

### 3.2 Capture Log Entry (`.graphkit/memory/.recall-log.jsonl`)

Appended on *actual* recall executions (when `--explain` is absent):

```json
{
  "ts": "2026-09-10T14:22:01.123Z",
  "query": "auth token expiry",
  "k": 5,
  "origin": "curator",
  "top": [
    { "id": "mem-a1b2", "salience": 0.14 }
  ],
  "injected": true,
  "scanned": 23
}
```

`top` carries `{ id, salience }` per returned hit; `injected` is always `true` for CLI-originated recalls. Scores and link flags are intentionally omitted — reconstruct them from the memory store at replay time if needed.

---

## 4. Execution Pipeline & CLI Interface

### 4.1 CLI Command Syntax

```bash
# Default ASCII explanation (no touchMemory side-effect)
gk memory recall "auth token expiry" --explain

# Emit structured JSON (for eval integration)
gk memory recall "auth token expiry" --explain --json

# Generate standalone HTML visualization in .graphkit/diagrams/
gk memory recall "auth token expiry" --explain --html

# Tag runtime provenance when invoking via subagent / curator
gk memory recall "auth token expiry" --origin curator
```

### 4.2 Pipeline Flow

```text
gk memory recall <query> [--explain] [--html] [--json]
   │
   ├─ If NOT --explain:
   │    ├─ Run expandedRecall()
   │    ├─ touchMemory() on all hits
   │    ├─ Append entry to .graphkit/memory/.recall-log.jsonl
   │    └─ Output standard JSON/text summary (existing behavior preserved)
   │
   └─ If --explain:
        ├─ Run explainRecall() [NO touchMemory, NO recall-log append]
        ├─ If --json: Print RecallExplanation JSON, exit 0
        ├─ If --html:
        │    ├─ Read recent .recall-log.jsonl for query history
        │    ├─ Generate self-contained HTML
        │    ├─ Write to .graphkit/diagrams/recall-<slug>.html
        │    └─ Print path to stdout, exit 0
        └─ Default:
             ├─ Format ASCII table with hits, terms, scores, and rejection reasons
             └─ Print to stdout, exit 0
```

---

## 5. UI & Presentation Specifications

### 5.1 ASCII Terminal View

```text
recall: "auth token expiry"   k=5   scanned=23   terms=[auth, token, expiry]

HITS
 #  score   sal   terms                 id          file
 1  0.42    0.14  auth, token, expiry   mem-a1b2    knowledge/token-ttl.md
 2  0.18    0.09  auth, token           mem-c3d4    patterns/renewal-loop.md
 3  0.035*  0.07  expiry                mem-e5f6    suggestions/renewal.md   ← linked via mem-a1b2 (0.5x)

REJECTED (top 3 of 20)
  mem-9a8b   FILTERED  superseded by mem-a1b2
  mem-7c6d   FILTERED  expired 2026-08-30
  mem-4e5f   OUTRANKED score 0.03 < k-cutoff (0.035)
```

- `*` flag on score denotes link expansion penalty (`0.5×`).
- Highlight matched terms per row.
- Explicit status column on rejected entries (`FILTERED` vs `OUTRANKED`).

### 5.2 Standalone HTML View (`.graphkit/diagrams/recall-<slug>.html`)

- **Header:** Query, timestamp, tokens, scanned/malformed count.
- **Hit Breakdown Bars:** Horizontal SVG/CSS bar per hit where width is proportional to `final_score`. Term badges colored by presence. Link expansion shown with dashed border and linkage tag.
- **Rejection Diagnostics Panel:** Collapsible table of non-qualifying docs with specific filter verdicts and expiry dates.
- **Replay Timeline:** If `.recall-log.jsonl` contains prior executions of this query, display historical scores vs. current evaluation to flag memory drift.
- **Theme:** Dual dark/light mode following the existing GraphKit / Archify palette.

---

## 6. Error Handling & Edge Cases

| Scenario | Behavior |
|---|---|
| Non-existent memory directory | Fail with `MEMORY_DIR_UNREADABLE`, exit code 1. |
| Zero matching docs | ASCII outputs `No hits found for query` with query terms, shows rejected candidate breakdown; HTML renders clean empty state. Exit 0. |
| HTML file write failure | Output ASCII to stdout, write non-fatal warning to stderr, exit 0 (visualizer never blocks CLI pipeline). |
| Corrupt row in `.recall-log.jsonl` | Skip corrupt line, increment parse failure counter, continue rendering. |
| Missing `.links.json` | Fall back to direct hits without link expansion (identical to `expandedRecall` behavior). |

---

## 7. Verification & Testing Plan

1. **Unit Tests (`test/memory-explain.test.ts`):**
   - Assert `explainRecall()` correctly categorizes hits, filtered (expired/superseded), and outranked docs.
   - Verify `0.5×` penalty calculation on link-expanded neighbors.
   - Confirm `--explain` execution does not call `touchMemory` (use count and timestamps unchanged).
   - Test empty query handling and token filtering (< 3 chars).

2. **Integration Tests (`test/cli-memory-explain.test.ts`):**
   - Run `gk memory recall "..." --explain` and test stdout against regex/snapshot.
   - Run `gk memory recall "..." --explain --html` and verify file creation in `.graphkit/diagrams/`.
   - Verify runtime log append in `.graphkit/memory/.recall-log.jsonl` on standard `gk memory recall`.

3. **Regression Safety:**
   - Standard `gk memory recall <query>` output must remain backward-compatible.
