# Trace-level evaluation

GraphKit grades at three levels, matching the agent-factory model:

| Level | What is graded | Where it lives |
|-------|----------------|----------------|
| Output | The artifacts a node produced | Evidence plane — `evidence:` keys, `gk gate` freshness checks |
| Action | What the node *did* — dispatches, rounds, retries, advisor escalations | Run journal — `trace.jsonl`, `dispatch.jsonl`, `advisor.jsonl` |
| Trace | The process as a whole — progress vs. thrash, respecting boundaries | Derived, scoped view of the journal materialized for the grader |

Before this feature only the first level was reachable: an `eval-gate` node
could read evidence files but had no deterministic way to see *how* upstream
nodes got there. Trace evaluation closes that gap.

## What the grader receives

Any node whose `role` is `eval-gate` (or `eval`/`advisor` — the same code
path covers them) gets a `trace` field in its compiled payload:

```yaml
nodes:
  worker:
    agent: Implementer
    objective: Build the feature
    owns: ["src/**"]
  review:
    agent: Code Reviewer
    role: eval-gate
    depend_on: [worker]
    eval:
      prompt: Grade the worker's output AND its process.
```

The payload's `trace.scope` is the node's transitive `depend_on` closure,
sorted — the set of nodes it is understood to be grading. At dispatch time
(every round, so a retry sees fresh state) the engine regenerates:

```
.graphkit/runs/<run-id>/trace/<node-id>.jsonl
```

and the grader's objective points at the file under a `## Run trace` header.
The file is a *derived, deterministic view* of the ledger — the hash-chained
`trace.jsonl` remains the only source of truth — regenerated rather than
appended, so resume and retry runs rewrite the same bytes.

## File contents

One JSONL entry per journal event touching a scoped node, ordered by `at`
timestamp, each with a `kind` discriminator:

- `{"kind":"dispatch", ...}` — the pre-launch intent record (when, attempt, via, pid)
- `{"kind":"trace", ...}` — a terminal round result: `status` (ok/fail/skipped/challenge), `evidence` keys produced, `duration_ms`, `notes`, `attempt`
- `{"kind":"landed", ...}` — an integration stamp (`commit`)
- `{"kind":"advisor", ...}` — a read-only escalation (`round`, `tier`, `streak`)

Nodes outside the scope never appear — an eval-gate grading `worker` cannot
see sibling nodes it does not depend on.

## Writing criteria against the trace

Trace criteria are ordinary prose criteria (`criteria/<id>.md`) — the grader
verifies them against the materialized file instead of evidence artifacts.
Two worked examples:

```text
# criteria/no-thrash.md
The node made progress without thrashing: it reached `ok` in at most
`retry.max_attempts` and no two consecutive trace entries share the same
failure `notes`. Count `kind=trace` entries with `status=fail` for the node.
```

```text
# criteria/respected-advisor.md
If an `kind=advisor` escalation fired, the next `kind=trace` entry for the
node must not repeat the identical failure signature — the node took the
diagnosis seriously rather than retrying unchanged.
```

## Caveat

Trace evaluation judges **process, not correctness**. A node can have a
clean trace — one dispatch, one `ok`, fresh evidence — and still ship a
wrong answer. Use trace criteria alongside output criteria (evidence
freshness, holdout rubrics), not instead of them.
