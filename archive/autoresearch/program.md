# Autoresearch Program — graph-kit retrieval efficiency

Frozen at commit `329e4fa` on branch `autoresearch/aug14`.

## Objective

`gk` must beat raw `grep`/`glob` at answering real questions about this repo.
It currently loses by ~42x. Close that gap by improving retrieval quality first,
then cost.

## Metric — one number, lower is better

```
metric = tokens_used + (wall_clock_seconds * 100) + (wrong_answers * 10000)
```

- `tokens_used` = `ceil(total_retrieved_bytes / 4)` — the retrieval payload an agent must read.
- `wall_clock_seconds` = end-to-end wall time for all 20 questions in one arm.
- `wrong_answers` = questions whose retrieved payload fails to surface every ground-truth
  anchor symbol. Correctness dominates: one miss costs more than the entire current payload.

## Ground truth — frozen

- `benchmark.jsonl` — 20 questions, each with `id`, `category`, `question`, `answer`,
  and the `command` that finds it. Categories: `where-defined`, `callers`,
  `dependencies`, `dead-code`, `data-flow`.
- **READ-ONLY after this node.** Never moved, never edited, never regenerated.
  Editing the benchmark to make a number improve invalidates the entire experiment.

## Baseline — measured, not estimated

| arm | metric | tokens | wall (s) | wrong | memory (MB) |
|---|---|---|---|---|---|
| grep/glob | 2936 | 2922 | 0.140 | 0 | 32.2 |
| gk | 124414 | 4361 | 0.526 | 12 | 36.3 |

gk loses on all three terms. The dominant term is `wrong_answers` (12 x 10000 = 120000
of gk's 124414). **Accuracy is the whole game — token and latency tuning are noise
until misses drop.**

## Invariants

1. **Time budget: 5 minutes per axis by default.** Exceed it only with an explicit
   reason recorded in the `description` column.
2. **One in-scope file per axis.** An axis edits exactly one file. Pick the file
   before starting; do not widen mid-run.
3. **Eval and benchmark code are OFF-LIMITS.** No edits to `benchmark.jsonl`,
   `src/eval/**`, `eval/**`, `scripts/cbm-parity.ts`, or the metric definition.
   These are the measuring instrument; changing them fakes progress.
4. **Branch: `autoresearch/aug14`.** All experiment commits land here, never on `main`.
5. **`graph.yaml` is frozen.** Commit `329e4fa` is the experiment base.
6. **`results.tsv` stays untracked.** It is local measurement scratch, not repo history.
7. **Every row is a real run.** No projected, interpolated, or remembered numbers.
   A failed run is recorded with `status: fail`, not omitted.

## results.tsv format

Tab-separated, this exact header:

```
commit	metric	memory_mb	status	description
```

- `commit` — short SHA the measurement was taken at.
- `metric` — the composite number above, integer.
- `memory_mb` — peak RSS of the run.
- `status` — `baseline-grep`, `baseline-gk`, `pass`, `fail`, or `revert`.
- `description` — what changed and the term-level breakdown (tokens, wall, wrong).

## Axes worth trying

Ordered by expected metric impact, all targeting `wrong_answers` first:

1. Query construction — gk sends a bare symbol name to `search_graph`; questions
   about callers and data flow need `trace_path`, not text search.
2. Result shaping — `limit: 5` truncates before the answer-bearing hop appears.
3. Tool routing — pick `search_graph` / `trace_path` / `query_graph` per question kind.

## Reproduce

```
bun /tmp/run_baseline.ts grep
bun /tmp/run_baseline.ts gk
```

Runner requires the CBM server at `/Users/harrynguyen/.local/bin/codebase-memory-mcp`
and the indexed project `Users-harrynguyen-Desktop-graph-engineering-graph-kit`.
