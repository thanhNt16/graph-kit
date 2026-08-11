---
name: gk:eval
description: Score a completed graph run's evidence and emit a MERGE/BLOCK gate verdict. Work-product mode (completeness/correctness of evidence keys) and memory mode (Letta 2x2 — adherence/retrieval/generalization/hygiene, abstention-weighted). Trigger: "eval", "score this run", "should this merge", "gate", "quality".
disable-model-invocation: false
---

# gk eval

The gate reads evidence and decides. "An agent finishes a change, opens it, and it goes in without a human reading it — not because anyone trusted the model, but because a gate read the evidence."

## Process

1. Read `graph.yaml` → the `eval-gate` node's `eval` config (`mode`, `rubric`, `abstention_weighted`, `llm_as_judge`).
2. Read `.graphkit/evidence/.index` and the evidence files.

### `work_product` mode
3. Collect each `evidence.required_keys` value from the evidence dir.
4. Apply `scoreWorkProduct({ required_keys }, evidence, rubric)` → per-key scorecard + `MERGE`/`BLOCK`.
5. (Optional) **LLM-as-judge:** if `eval.llm_as_judge.enabled`, spin the existing `adversarial-verification` topology as a subgraph — refuter agents (from `eval.llm_as_judge.refuters`) try to refute the verdict; the gate survives only if ≥ `survive_threshold` refuters fail. Pin model/temp 0/`seed` for determinism.

### `memory` mode
6. Gather memory state from `.graphkit/memory/`: adherence (did node outputs respect recalled constraints?), retrieval (were relevant memories fetched — check recall logs), generalization (did distilled `experience`-type memories transfer?), hygiene (count stale / contradictory / duplicate — parse `expired`, `superseded_by`).
7. Apply `scoreMemory(state, { abstention_weighted })`. **Abstention-weighted:** confidently answering from a stale memory is penalized more than admitting ignorance.

### `both` mode
8. Run work_product, then memory, and combine the scorecards.

9. Write `.graphkit/reports/{run-id}-eval.md`:
   - Verdict line (`MERGE` / `BLOCK` + per-mode scores)
   - Per-key / per-axis breakdown (per-category over aggregate)
   - Any LLM-as-judge refuter tally

## Determinism

The rubric is code; the only model involvement is the optional pinned LLM-as-judge. If the harness isn't deterministic, the number is an ad — so the runner pins model, temperature 0, and seed.

## Degradation

If `codebase-memory-mcp` is unavailable, `memory` mode reports `UNAVAILABLE` (not `BLOCK`); `work_product` mode still completes.
