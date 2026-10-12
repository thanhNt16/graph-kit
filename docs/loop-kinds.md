# Loop kinds: judged vs polling vs counting

Graph-level `loops:` groups declare how a span of nodes repeats. `kind` picks
the exit mechanism — the default is today's behavior, so existing graphs need
no changes.

## `kind: judged` (default)

The orchestrator evaluates a natural-language `stop_when` predicate (or the
`gate_evidence` set) between rounds. Right for fuzzy conditions — "tests pass",
"review has no open findings" — that only a model can judge. Costs model
attention every round.

```yaml
loops:
  - nodes: [implement, test]
    max_rounds: 4
    kind: judged          # optional — this is the default
    stop_when: tests pass
    no_progress_limit: 2  # breaker across all kinds
```

Rounds are journaled by `gk run round <index>` exactly as before.

## `kind: polling`

Zero-token waiting on a mechanical condition: does a *fresh* (non-stale,
non-superseded) evidence marker exist for `poll.evidence_key`? The
orchestrator calls `gk run poll <index>` each round — each call journals one
round and returns `check.satisfied` plus `check.state` (missing / empty /
superseded / stale / unknown / fresh).

```yaml
loops:
  - nodes: [watch]
    max_rounds: 20
    kind: polling
    poll:
      evidence_key: deploy-status   # <evidence_dir>/deploy-status.md
      interval_ms: 5000             # advisory pacing for the caller
      max_wait_ms: 600000           # wall-clock budget from the first poll
```

Exit conditions, in precedence order:

- marker satisfied → `stop_reason: "condition_met"`
- `no_progress_limit` identical rounds → `stop_reason: "no_progress"`
- `elapsed_ms >= max_wait_ms` → `stop_reason: "poll_timeout"` (`check.bound: "max_wait_ms"`)
- `round >= max_rounds` → `stop_reason: "poll_timeout"` (`check.bound: "max_rounds"`)

`gk run poll` never sleeps — `interval_ms` tells the caller how long to wait
between invocations. `poll.elapsed_ms` is derived from the journal's first
round timestamp, so the budget survives restarts. Polling a group of another
kind is refused with `LOOP_KIND_MISMATCH`; `gk run round` still journals a
polling group's round and evaluates the same check.

Use it to wait on evidence stamped by `gk evidence add` — a human, a CI job,
or a node in another run — without burning a model judgment per cycle.

## `kind: counting`

Deterministic exit over run state — no predicate text, no judge. `exit_when`
declares at least one predicate; the first satisfied wins:

```yaml
loops:
  - nodes: [lint, fix]
    max_rounds: 6
    kind: counting
    exit_when:
      evidence_all_fresh: [lint-report, fix-summary]
      # rounds_eq: 3            # alternative: stop after N rounds exactly
```

`gk run round <index>` evaluates the predicate per round:

- every `evidence_all_fresh` key fresh → `condition_met`
- `round >= rounds_eq` → `condition_met`
- otherwise the usual bounds apply (`no_progress`, `max_rounds`)

Per-key states land in `check.evidence` so the journal shows *which* key held
the loop open.

## Choosing

- Fuzzy / semantic exit → **judged**
- Wait for an artifact to appear or go fresh → **polling**
- Exit on evidence coverage or a fixed round count → **counting**

Journal lines (`runs/<id>/rounds/<group>.jsonl`) record `kind` and the
`check` payload for mechanical kinds, so `gk run analyze` and resume logic
read the same durable state — never orchestrator prose.
