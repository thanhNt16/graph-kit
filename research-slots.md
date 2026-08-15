# Research Slots — Round 1

Dispatch for the research loop. One OPEN research question per axis slot, weighted by
actual metric impact. Metric = tokens + wall*100 + wrong*10000.

Baseline reminder (results.tsv): gk arm = 4361 tokens + 52.6 wall + 120000 wrong =
**124414**. Wrong-answers are **96.5%** of the gap; tokens 3.5%; wall **0.04%**.
Accuracy is the whole game. A slot that cannot move wrong_answers is, at best, a 3%
slot — and a latency slot is a 0.04% slot, which is below the noise floor and earns
no researcher this round.

Priority ordering: **axis-retrieve (fixes the 12 wrong) > axis-index (only if
transport corruption is real) > axis-extract (off the benchmark critical path — empty).**

---

## SLOT 1 — axis-retrieve  (`src/cli/commands/graph.ts`)   [HIGHEST PRIORITY]

### Open question

**Can a question-kind classifier route each benchmark question to the correct CBM
primitive (`search_graph` for where-defined, `trace_path` for callers/data-flow,
`query_graph` for dead-code/symbol-sets) such that the 12 structural misses flip to
correct WITHOUT regressing the 8 currently-right text-search wins — and is a keyword
lexicon sufficient, or does it require LLM few-shot?**

This is the single highest-leverage question in the whole loop. R1/R2 in
`idea-backlog.md` propose the *solution* (classify-then-dispatch); the open
*research* question is whether the routing is reliable enough on these 20 questions
to recover ≥10 of 12 anchors, and whether the existing `trace_path`/`query_graph`
primitives actually return the gold anchor when seeded correctly. If the primitives
themselves are weak (limit truncation per R4, no source on hops per R5), routing
alone is insufficient and the slot must report that.

### What-to-find (concrete mechanisms, not surveys)

1. **Intent lexicon for the 6 benchmark categories.** The gold answers carry their
   category (`callers`, `data-flow`, `where-defined`, `dependencies`, `dead-code`).
   Test whether deterministic keyword rules hit ≥85% routing accuracy:
   - `"who calls"`, `"which .* calls"` → callers → `trace_path(direction=inbound)`
   - `"trace .* from"`, `"how does .* map"`, `"how are .* mapped"` → data-flow → `trace_path(direction=both, depth≥3)`
   - `"where is .* defined"`, `"where .* implemented"` → where-defined → `search_graph` (current behavior, keep)
   - `"declared but never"`, `"unused"`, `"dead"` → dead-code → `query_graph` set-complement
   - `"what does X depend on"`, `"depend on to"` → dependencies → `search_graph` + `trace_path` outbound merge
2. **Anchor-recovery test.** For each of q02 q03 q06 q07 q09 q13 q14 q15 q16 q17 q19
   q20, run the routed primitive (seeding `trace_path.function_name` from
   `search_graph` top `qualified_name`), and check whether the gold answer's file or
   symbol appears in the result set. This isolates "routing was wrong" from
   "primitive returned the wrong thing."
3. **Primitive-capacity ceiling.** Separately test R4 (does `limit:5` truncate the
   answer-bearing hop on q09/q20?) and R5 (do `trace_path` hops lack source coords,
   making q02's call-site anchors invisible?). If routing is correct but anchors
   still missing, the real blocker is primitive capacity, not classification — report
   that distinction.
4. **Regression guard.** Confirm the 8 correct (q01 q04 q05 q08 q10 q11 q12 q18) stay
   correct under the new routing — where-defined questions must NOT be diverted to
   trace/query.

### Search pointers (specific systems/papers/repos)

- **CodeQL** (github/codeql) — query library has pre-built `CallGraph`,
  `DataFlow`, `DeadStore` predicates; their dispatch (NL → query template) is the
  canonical pattern. Read the `CodeQL language predicates` docs for the
  callers/data-flow/dead-code query shapes.
- **Semgrep** (returntocorp/semgrep) — rule packs for `"pattern-not"` (dead-code)
  and `"pattern-either"` (caller sets); lighter-weight than CodeQL.
- **SCIP / LSIF** (sourcegraph/scip) — indexed code-intelligence protocol; their
  query types (`definitions`/`references`/`implementations`) map directly onto the
  benchmark's 6 categories. Sourcegraph's code-intel backend is the production
  reference for NL→structural-query routing.
- **RepoCoder** ( heterogeneous/RepoCoder, Zhang et al. EMNLP 2023) and
  **CoCoMIC** ( microsoft/coco-mic) — iterative retrieve-then-generate over repo
  structure; their retrieval-staging heuristics inform when to widen via trace.
- **GraphRAG** (microsoft/graphrag) — query-template dispatch over a code KG;
  pattern for pre-rolled Cypher templates (R6).
- **MCP itself** — `@modelcontextprotocol/sdk` shows the canonical tool-dispatch
  pattern; the gk CBM contract (`src/cbm/contract.ts:23-35`) already mirrors
  MCP tool semantics, so routing logic can lift MCP's tool-selection conventions.

### Acceptance test (what evidence makes a found idea worth queueing)

A found routing scheme is worth queueing into `idea-backlog.md` ONLY if a prototype
on the 20 frozen questions demonstrates ALL of:

- **Routing accuracy ≥ 85%** (≥17/20) vs gold category, measured by keyword lexicon
  first; if the lexicon is <85%, escalate to LLM few-shot and re-measure.
- **Anchor recovery ≥ 10/12** on the missed set — the routed primitive's result set
  contains the gold file or symbol.
- **Zero regressions** on the 8 currently-correct questions.

If routing accuracy <60% OR anchor recovery <6/12, **kill the idea** — report that
the primitives (not the routing) are the blocker, and the slot's real finding is a
capacity gap (R4/R5), not a classification gap. Either way the researcher returns a
verdict, not a survey.

---

## SLOT 2 — axis-index  (`src/cbm/client.ts`)   [MID PRIORITY — measurement-gated]

### Open question

**Does the JSON-RPC-over-stdio transport in `client.ts` actually drop or corrupt
frames (I4) or hang the pending map (I5) during a 20-question run — and if so, is
that a measurable contributor to the 12 wrong answers? Or are the wrong answers
purely an axis-retrieve routing problem that axis-index cannot touch?**

This slot is gated on a measurement, not a build. The metric math says latency
micro-optimization (I1/I2/I3: close-kill, initialize handshake, line batching) is
0.04% of the gap and is **below the noise floor** — it earns no researcher this
round. The ONLY axis-index question worth asking is whether transport *correctness*
(I4 dropped frames, I5 hung promise) is silently producing empty/partial search
results that surface as wrong answers. If the transport is sound, this slot is
honestly empty.

### What-to-find (concrete mechanisms)

1. **MCP stdio framing check.** Read the MCP transport spec and the
   `@graphkit/codebase-memory-mcp` server's stdout behavior: does it emit one
   JSON-RPC message per `\n` (newline-delimited JSON, the MCP stdio convention)? If
   yes, `client.ts:29-44` readline-per-line parse is correct-by-spec and I4 is a
   non-issue. If the server emits multi-line or batched frames, I4 is real.
2. **Pending-map hang probe.** In `client.ts:27,48-57`, is there any evidence
   (timeout, eviction, unhandled rejection) that a `call()` never resolved during
   the baseline run? The baseline completed in 0.526s wall for 20 questions
   (~26ms/question) — if true, no hang occurred and I5 is hypothetical. Find the
   evidence either way: instrument reasoning, log inspection, or a deterministic
   repro.
3. **Startup cost sanity check.** `npx -y @graphkit/codebase-memory-mcp` on first
   run downloads the package. Confirm whether the benchmark reuses a warm client or
   spawns fresh per question — 0.526s total wall says spawn is cached/cheap. If
   confirmed, I1/I2/I3 are definitively dead and should be marked so.
4. **Wrong-answer attribution.** For each of the 12 misses, can a transport fault
   plausibly explain it, or does the gold answer require structural traversal that
   `search_graph` was never going to return regardless of transport integrity? This
   attributes the misses to either axis-retrieve (routing) or axis-index (transport).

### Search pointers

- **MCP spec** — `modelcontextprotocol/specification`: the "Transports > stdio"
  section mandates newline-delimited JSON-RPC 2.0. This is the authority on whether
  I4's framing fear is warranted.
- **`@modelcontextprotocol/sdk`** (TypeScript reference) — `src/shared/stdio.ts`
  shows the canonical readline framing; compare to `client.ts:29-44`.
- **JSON-RPC 2.0 over stdio** — LSP (`microsoft/language-server-protocol`) and
  `vscode-jsonrpc` use the same framing (`Content-Length` header OR
  newline-delimited); the LSP reference impl is the production-proven pattern.
- **`@modelcontextprotocol/inspector`** — MCP's own debugger; can surface dropped
  frames if pointed at the CBM server.

### Acceptance test

This slot produces one of two honest verdicts:

- **QUEUE I4/I5** only if the researcher produces concrete evidence (a repro, a log,
  or a spec-violation finding) that frames are dropped or promises hang during a
  representative 20-question run. AND the resulting empty/partial result would have
  caused a wrong answer that routing alone cannot fix.
- **DECLARE EMPTY** if (a) the server emits newline-delimited JSON per spec, (b) the
  baseline run shows no hung promise, and (c) the 12 misses are attributable to
  routing (axis-retrieve), not transport. In that case, explicitly record that
  axis-index has no worthwhile open question this round and I1/I2/I3 are below the
  0.04% noise floor.

Do NOT send a researcher to build I1/I2/I3 latency optimizations. The dispatch
instruction forbids it, and the metric math confirms it.

---

## SLOT 3 — axis-extract  (`src/eval/forgetting.ts`)   [EMPTY THIS ROUND]

### Verdict: no worthwhile open question.

**Reasoning (be explicit, per dispatch constraint):**

- `forgetting.ts` governs run-memory entity hygiene for `gk-recall`
  (`actRScore`, `recencyDecay`, `ageDays`, `shouldExpire`). E1–E5 are all
  memory-survival / recall-quality ideas.
- The benchmark (q01–q20) is 20 frozen **repo-structure** questions. **None** read
  recall memory or depend on memory-entity read-back. grep/glob answers them with
  zero memory state.
- The one apparent touchpoint, **q13** ("How does `actRScore` combine relevance,
  connectivity, frequency, recency?"), has its gold answer *in* `forgetting.ts` —
  but q13's *miss* is a **retrieval** failure (search_graph didn't return the
  function body / limit truncated it), owned by **axis-retrieve** (R3 seed + R4
  raise limit). It is NOT a memory-hygiene failure. No E-idea fixes q13.
- Therefore E1–E5 do not move the benchmark metric. Sending a researcher here burns
  a slot for 0 metric points.

**When to revisit:** re-open this slot in a round where the benchmark adds
recall-quality questions (e.g., "what did the previous run conclude about X?"), or
when the run length grows long enough that memory pollution degrades
extraction-side answers. Until then, **empty.**

---

## Evidence key

`research_slots`: SLOT 1 axis-retrieve (routing-classifier, ≥85%/≥10-of-12/zero-regression gate),
SLOT 2 axis-index (transport-correctness measurement, queue-or-empty verdict),
SLOT 3 axis-extract (empty — off benchmark critical path).
