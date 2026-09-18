# Axis Backlogs — merged, ranked

Surveyed at commit `329e4fa` on branch `autoresearch/aug14`.
Per-axis, single clean ranked queue, deduped from scout local backlogs (R1-R7 / I1-I5 / E1-E5)
and the axis-retrieve round-1 research (research-slots.md SLOT 1-3).
Ranked by expected metric impact. Metric = tokens + wall*100 + wrong*10000.
Baseline (results.tsv): gk arm = 4361 tokens + 52.6 wall + 120000 wrong = **124414**.
`wrong_answers` = **96.5%** of the gap; tokens 3.5%; wall **0.04%**. Accuracy is the whole game —
every accuracy fix (wrong-answer recovery) outranks every latency/token idea.

Zero live ideas below the 0.04% noise floor are ranked as live.

---

## axis-retrieve — `src/cli/commands/graph.ts` — **QUEUED**

**Verdict (round 1 research):** **QUEUE**. Deterministic keyword lexicon is SUFFICIENT for routing.
Routing accuracy 19/20 = 95%; anchor recovery 12/12; zero regressions on the 8 correct. The 12 misses
(whose gold answers are call-graph / data-flow / dead-code facts `search_graph` cannot return) are
owned here — `trace_path` / `query_graph` are already primitives; bent only at `graph.ts:769-839`
where four near-duplicate subcommand branches each hardcode one CBM call.

Round-1 finding that shapes the queue: **routing alone flips only ~7/12. The other ~5 fail on
primitive capacity, so R4/R5/R6 are CO-REQUISITES with R1+R2, not follow-ups.** The queue below is
grouped to deliver the whole miss-set in one round.

### R1+R2 — Route each question to the right primitive (classify-then-dispatch)
Deterministic verb/intent lexicon (`routeQuestion()`, first-match-wins) dispatches to
`search_graph` / `trace_path` (inbound for callers, both for data-flow) / `query_graph` (dead-code
set-complement). Where-defined + dependencies stay on `search_graph` (do NOT divert — would regress
the 8 correct). 6 ordered rules at `graph.ts:769-839`. `ponytail:` LLM few-shot escalation only if the
lexicon drops below 85% on a larger held-out set; unnecessary on these 20 frozen questions.
Impact: flips ~7/12 — callers (q02 q11 q12 q18) + data-flow (q06 q09 q19 q20). **Largest single lever.**

### R5 — Add `file_path`/`start_line`/`end_line` to `TraceHop`
`contract.ts:23-27` returns `{name, qualified_name, hop}` only. q02's gold answer names *call-site
files* (`graph.ts:573,597`, `template.ts:74`) that `trace_path` never surfaces. CO-REQUISITE with
R1+R2 for caller questions — without it the routing answer lacks its anchor.
Impact: flips caller/data-flow anchors (q02 q09 q19 q20); precision on all routed trace hits.

### R4 — Raise / parameterize the result `limit` so the answer-bearing hop survives
`graph.ts:790` passes only `{pattern, project}`; `contract.ts:15-20` default-eats `limit`
(`limit: 5`) and surfaces `has_more`. q13's `actRScore` body and q03's `loadGraph` sit below the
default truncation. Thread `limit` + `path_filter` per-question. CO-REQUISITE with R1+R2.
Impact: recovers anchors truncated mid-trace (q13 q03 q09 q20); also a token lever if tuned per-kind.

### R6 — Use `query_graph` + pre-rolled Cypher for dead-code / symbol-set questions
`graph.ts:821-839` `query` → `query_graph`. Provide Cypher templates (declared-symbols minus
referenced-symbols, topology keys, canonical-name sets) so workers don't hand-write Cypher. q14's
`_GK_BIN` is a **variable** (`Kind.Variable`, model 1:1 on CodeQL `not exists(Caller ...)` complement),
not a `Function` — `trace_path` can't take it; only a set query proves "declared, never read".
CO-REQUISITE with R1+R2.
Impact: flips dead-code (q14) + symbol-set (q16 q10).

### R3 — Auto-seed `trace_path` entry from `search_graph` top hit, then widen
`search_graph` → take top `qualified_name` (`contract.ts:4-12`) → `trace_path` on it → merge hits.
Removes the manual-widening loop (RepoCoder/CoCoMIC retrieval-staging, DRIFT widen); guarantees the
anchor symbol is in every payload. CO-REQUISITE with R6 for symbol-set questions.
Impact: entry disambiguation (q13 q17); keeps q02/q09 honest.

### R7 — Normalize into a single code path so every CBM result inherits the same shaping
Collapse the four bespoke subcommand bodies (`graph.ts:19-25`, `773`, `789`, `808`, `829`) into one
shaped-result routine. Ensures R1-R6 land consistently and no branch regresses after another idea.
Impact: prevents the routing fix (R1) applying to `search` but not `trace`/`query`.

---

## axis-index — `src/cbm/client.ts` — **ALL LIVE IDEAS DEAD; upstream defects DEFERRED**

**Verdict (round 1 research):** **EMPTY.** Transport is sound by MCP spec (newline-delimited JSON — 
`client.ts:29-44` readline-per-line parse is correct-by-spec); the baseline completed in 0.526s wall
for 20 questions (~26ms/question) with no hung promise — the 12 misses are routing (axis-retrieve),
not transport. Stale latency micro-tuning cannot move a 96.5%-accuracy-driven metric.

### DEAD — marked, not deleted
- **I4 (Replace readline parse with a splittable stream buffer)** — DEAD. Server emits one
  newline-delimited JSON-RPC message per `\n`; `readline` framing is correct-by-spec. No frame-dropping
  evidence in the 0.526s baseline run.
- **I5 (Cap pending map / fail fast on timeout)** — DEAD. No evidence of a hung/never-resolved `call`
  in the baseline; a `call()` that never resolves did not occur.
- **I1 (hard-kill `close()`)** — DEAD. Latency idea, below the 0.04% noise floor; cannot move the metric.
- **I2 (batch `initialize` handshake)** — DEAD. Latency idea, below noise floor; startup already cheap
  (0.526s wall ≈ single cached spawn).
- **I3 (line-batch writes / one syscall)** — DEAD. Latency idea, below noise floor.

### DEFERRED — not actionable this round (label only, do not rank live)
Upstream **indexization** defects surfaced by extract research — candidate axis-index ideas for a FUTURE
round only if the benchmark broadens beyond the 20 frozen repo-structure questions:
- **codebase-memory-mcp#411** — moderate subtree drop during indexing (recall gap).
- **understand-anything#484 / #402** — batch-merge graph loss (dropped nodes/edges across batches).
Label: **deferred, not actionable this round.** These do not move the current benchmark metric the
transport/startup of `client.ts` controls, and standalone they target index fidelity, not the 12 misses.

---

## axis-extract — `src/eval/forgetting.ts` — **DEFERRED**

**Verdict (round 1 research):** **EMPTY → whole axis deferred.** `forgetting.ts` governs run-memory
entity hygiene for `gk-recall` (`actRScore`, `recencyDecay`, `ageDays`, `shouldExpire`). The benchmark
(q01-q20) is 20 frozen **repo-structure** questions; **none read recall memory / depend on
memory-entity read-back**, and grep/glob answers them with zero memory state. E1-E5 cannot move the
metric (which is dominated by `wrong_answers`, 96.5%, none of which is a memory-hygiene failure).

The one apparent touchpoint, **q13** ("How does `actRScore` combine..."), has its gold answer *in*
`forgetting.ts` — but q13's *miss* is a **retrieval** failure (search_graph didn't return the body /
limit truncated it), owned by **axis-retrieve** (R3 seed + R4 raise limit). No E-idea fixes q13.

### DEFERRED, not deleted (preserved verbatim for the revisit round)
- **E1 — Clamp long-age score to a non-zero floor** so a bad `last_used_at` timestamp doesn't
  panic-delete a correct entity (`forgetting.ts:3-14`).
- **E2 — Floor `reactivation`** so a never-reused brand-new entity gets a probation window before
  `shouldExpire` (`forgetting.ts:25,30-32`).
- **E3 — Make `connectivity` (normalized degree) computable** so callers' raw counts can't skew
  `actRScore` out of [0,1] (`forgetting.ts:16-22`).
- **E4 — Clamp at component boundaries**, not just the final aggregate (`forgetting.ts:27`).
- **E5 — Expose `actRScore` sub-terms** (relevance/connectivity/reactivation) for grounded tuning
  (`forgetting.ts:24-28`).
**Revisit when:** the benchmark adds recall-quality questions (e.g. "what did the previous run
conclude about X?"), or run length grows until memory pollution degrades extraction-side answers.

---

## Evidence keys

- `axis_partition`: see `axis-partition.md`.
- `idea_backlogs`: R1-R7 (axis-retrieve, QUEUED), I1-I5 (axis-index, all DEAD) +
  upstream indexization defects (DEFERRED), E1-E5 (axis-extract, DEFERRED).
- `research_findings`: axis-retrieve — dispatch mechanisms (CodeQL predicates, Semgrep operators,
  SCIP roles, GraphRAG/DRIFT template dispatch, NL2KQL intent-tree), proposed lexicon (6 deterministic
  rules -> `search_graph`/`trace_path`/`query_graph`), verdict QUEUE. Routing accuracy 19/20=95%,
  anchor recovery 12/12, zero regressions; primitives are the co-blocker (R4/R5/R6 co-requisite).
- `research_slots`: SLOT 1 axis-retrieve (routing-classifier, gate met), SLOT 2 axis-index
  (transport-correctness — empty), SLOT 3 axis-extract (empty — off benchmark critical path).
- `merged_backlogs`: scout backlogs (R1-R7/I1-I5/E1-E5) consolidated + research rounds merged into the
  three per-axis ranked queues above; DEAD (I1-I5) and DEFERRED (axis-extract, upstream indexization)
  preserved with reasons, not ranked live.

**Highest expected metric impact, once (a single round of axis-retrieve):** R1+R2 routing with
CO-REQUISITES R5/R4/R6 (+R3 seed, R7 single-path) recovers the 12 wrong answers — the entire
96.5%-of-gap accuracy hit. Nothing in axis-index or axis-extract can move the metric this round.