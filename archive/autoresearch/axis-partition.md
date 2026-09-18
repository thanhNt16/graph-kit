# Axis Partition — graph-kit autoresearch

Benchmark: 20 frozen repo questions (`benchmark.jsonl`), metric = tokens + wall*100 + wrong*10000.
Baseline: grep/glob 2936 (0 wrong) vs gk 124414 (12 wrong). gk loses on **wrong_answers**
(12×10000 = 120000 of its 124414). Accuracy is the whole game.

Three disjoint axes. Each edits EXACTLY ONE in-scope file under `src/`, so parallel
workers never touch the same file. Files are disjoint (no shared imports, no shared
symbols written by two axes).

## Partition table

| axis | in-scope file (real path) | why this file owns this axis |
|---|---|---|
| **axis-retrieve** | `src/cli/commands/graph.ts` | The entire retrieval surface lives here: the `search`/`trace`/`query` subcommands that call CBM, plus `loadGraph` (q03). It is the single place the benchmark's wrong answers are produced — it chooses *which* tool (`search_graph` vs `trace_path` vs `query_graph`) and *what payload* to send. Highest leverage. |
| **axis-index** | `src/cbm/client.ts` | The CBM spawn + JSON-RPC transport — indexing (`index_repository`) and every retrieve call ride this transport (q07 default `npx -y @graphkit/codebase-memory-mcp`). One file owns spawn latency, startup cost, request buffering, and `close()` teardown. |
| **axis-extract** | `src/eval/forgetting.ts` | Memory-graph entity/edge hygiene scoring: `actRScore` (q13), `recencyDecay`, `ageDays`, `shouldExpire`. The only code that decides which memory entities survive / are read back — the recall-quality side of extraction. Small, self-contained, zero overlap with the other two files. |

## Disjointness proof

- `src/cli/commands/graph.ts` imports: `cbm/client.js`, `cbm/contract.js`, `cbm/index.js`,
  `compiler/emitter.js`, `compiler/validate.js`, `errors.js`, `schemas/graph.schema.js`,
  `schemas/topology/index.js`, `cli/ascii.js`, `cli/output.js`, `cli/svg.js`, `cli/commands/kit.js`.
- `src/cbm/client.ts` imports: `node:child_process`, `node:readline` only.
- `src/eval/forgetting.ts` imports: nothing (pure functions, stdlib-free).

No file shares an import with another; the three are a DAG fan-in (graph.ts → client.ts) plus
an isolated pure module. No source line is edited by two axes. `src/cbm/index.ts` (the
`indexProject` wrapper) is adjacent to `client.ts` but is a separate file — index-axis edits
stay inside `client.ts`; `indexProject` is untouched.

## Constraints honored

- Read-only survey. No source, `graph.yaml`, benchmark, or eval edited.
- No commits, no deps, no branch switch. Deliverables are two untracked files at repo root.
- `benchmark.jsonl`, `src/eval/**` (except the designated extract file), `eval/**`,
  `scripts/cbm-parity.ts`, and the metric definition are off-limits to all axes.

## Evidence key

`axis_partition`: the table above.
