---
name: gk-recall
description: Query the run's memory store for context relevant to the current node's objective. Keyword×salience retrieval with temporal-validity and supersede filters. Trigger: "recall", "what do we know about", "memory", "prior context", "past decisions".
when_to_use: A graph node needs prior-run or intra-run memory — constraints, past decisions, diagnosed errors, distilled experience — that it would not otherwise know to ask for.
user-invocable: true
disable-model-invocation: false
---

# gk recall

Memory lives in `.graphkit/memory/` OKF files. Retrieval is `gk memory recall` —
NOT CBM: `search_graph` over a markdown-only project returns 0 hits (.md indexes
as File/Module shells with no searchable content; measured 2026-08-15, see
`scripts/memory-recall-eval.ts`).

## Process

1. Build the query from the calling node's `objective` + any explicit query argument. Honor an `as_of` argument if the caller supplied one (defaults to now).
2. Run `gk memory recall --json "<query>"`. This single command:
   - ranks memories by keyword-overlap × salience,
   - drops expired / not-yet-valid / past-valid entries,
   - resolves `superseded_by` chains to the newest member,
   - returns top `recall_topk` — resolved from the graph's `memory.recall_topk` (default 5),
   - reports entries dropped for malformed validity dates in a `malformed` count (they are excluded and counted, not silently kept),
   - fails with `MEMORY_DIR_UNREADABLE` (exit 1) when the store exists but cannot be read — only a missing store returns empty results,
   - and reinforces every survivor (`gk memory touch`: `use_count` + `last_used_at` bump) so ACT-R decay keeps what recall actually uses.
3. Read each returned `file` under `.graphkit/memory/` for full content. Surface a `stale: true` flag if the memory's source evidence predates the current node's `depend_on` ancestors. Report the `malformed` count alongside results when nonzero.
4. Return each memory with: `id`, `type`, one-line summary, full `content`, `as_of` validity window.

## Store layout

`gk memory recall` searches the memory root AND its subfolders (`patterns/`,
`suggestions/`), then joins `.links.json` neighbors below direct hits. Patterns carry
`label`/`members` in their body — recall them by the node names they contain
(e.g. `gk memory recall "plan build verify"`). Hits are reinforced automatically
(`use_count` bump); dismissed suggestions stay recallable but `gk suggest` hides them.

Reference implementation of the filters: `src/eval/memory-recall.ts` (unit-tested; the memory-recall eval holds it to `hit_rate ≥ 0.8` and zero validity violations).

## Degradation

If the `gk` CLI is unavailable, scan `.graphkit/memory/*.md` directly with `Grep`/`Read`, parse frontmatter, and apply the same filters manually (expired / valid-window / supersede-chain / malformed-date exclusion — see `src/eval/memory-recall.ts`). Tag results `source: fallback-scan`.

## Output

A concise ranked list handed back to the calling node's context. Touch writes only reinforcement fields (`use_count`, `last_used_at`) — never content.
