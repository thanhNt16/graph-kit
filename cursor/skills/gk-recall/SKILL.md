---
name: gk-recall
description: Query the run's memory graph for context relevant to the current node's objective. Fused semantic + temporal + entity retrieval. Use when a graph node needs prior-run or intra-run memory — constraints, past decisions, diagnosed errors, distilled experience. Trigger: "recall", "what do we know about", "memory", "prior context", "past decisions".
disable-model-invocation: false
---

# gk recall

Memory lives in the `codebase-memory-mcp` graph project named in `graph.yaml` `topology_config.memory.project` (default `graph-kit-memory`), populated from `.graphkit/memory/` OKF files by `gk memory index`.

> **Note:** For full function, `codebase-memory-mcp` must be configured in `.cursor/mcp.json`. If unavailable, grep over `.graphkit/memory/` is used as fallback (see Degradation below).

## Process

**0. Ensure the memory index is fresh.** If `.graphkit/.memory-dirty` exists OR `.graphkit/.last-index` is absent, the memory project is stale or unbuilt — run `gk memory index --json` before querying. (Skip silently if CBM is unavailable; the Degradation path below does not need it.)

1. Read `graph.yaml` → `topology_config.memory.project` (default `graph-kit-memory`) and `recall_topk` (default 5).
2. Build the query from the calling node's `objective` + any explicit query argument.
3. **Semantic + keyword:** call `mcp__codebase-memory-mcp__search_graph` with `{ project, query: <objective>, limit: recall_topk * 3 }`. This runs BM25 + vector (`nomic-embed-code`) over memory files.
4. **Temporal validity:** for each hit, read its YAML frontmatter `valid_from` / `valid_to` / `expired`. **Drop** any memory where `expired: true` or `now < valid_from` or `valid_to < now`. Honor an `as_of` argument if the caller supplied one.
5. **Supersede resolution:** if a memory has `superseded_by`, follow the chain to the current version; surface only the newest non-expired member.
6. **Entity traversal:** optionally call `mcp__codebase-memory-mcp__query_graph` with a Cypher predicate on tags / `[[wikilinks]]` to pull directly related memories.
7. Rank survivors by `salience × recency` (parse `salience` and `last_used_at` from frontmatter); return top `recall_topk`.
8. Return each memory with: `id`, `type`, one-line `content` summary, full `content`, `as_of` validity window. **Surface a `stale: true` flag** if the memory's source evidence predates the current node's `depend_on` ancestors.

## Degradation

If `codebase-memory-mcp` tools are unavailable, fall back to scanning `.graphkit/memory/*.md` directly with `Grep`/`Read`, parse frontmatter, apply the same temporal/supersede/expires filters. Tag results `source: fallback-scan` and note the absence of semantic ranking.

## Output

A concise ranked list handed back to the calling node's context. Does not write files.
