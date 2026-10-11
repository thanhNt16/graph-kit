# Regression promotion (`gk evidence promote`)

A blocked `gk gate` verdict is normally terminal: the failure is observed, fixed
by hand, and forgotten. Promotion closes the loop — one command turns a failed
run into a committed, reusable regression artifact so the system is harder to
break in the same way twice.

## Workflow

```bash
# a run fails / the gate blocks
gk run end --status blocked

# freeze the failure into a scenario fixture
gk evidence promote --run 20260101-000001-mygraph --holdout
# → scenarios/promoted/<run-id>-<node>/case.yaml
# → criteria/<node>-regression.holdout.md        (with --holdout)

git add scenarios/promoted/<run-id>-<node>/case.yaml criteria/<node>-regression.holdout.md
```

What `promote` reads:

- the run's ledger (`meta.json`, `trace.jsonl`, `index.jsonl`) for node
  statuses, the recorded graph, and the run's final status;
- the **deterministic evidence gate replayed** over the recorded graph's
  `evidence.required_keys` — the same read `gk gate` made when it blocked —
  yielding the failed criteria ids and the evidence digests present/absent.

What it writes:

- `scenarios/promoted/<run-id>-<node>/case.yaml` — a fixture in the shape of the
  `eval/golden` scenarios: `input.required_keys`, the node's `objective` at
  failure, the observed `evidence` digests, `expected_verdict: BLOCK`,
  `failed_criteria`, and `node_statuses`.
- with `--holdout`: `criteria/<node>-regression.holdout.md` — a sealed
  criterion (see [holdout scenarios](./holdout-scenarios.md)) generated from the
  failure: which criteria regressing, plus the original run id, date, and
  evidence digests. It loads through `loadCriteria` like any other criterion.

Wiring it back in: reference the promoted criterion id from a future graph's
`evidence.criteria` (or an eval-gate node's `refs`) so the next run grades
against the failure it just survived:

```yaml
evaluator:
  role: eval-gate
  refs:
    - path: criteria/builder-regression.holdout.md
      purpose: promoted regression rubric
evidence:
  criteria: [builder-regression]
```

## Options

- `--run <id>` — run to promote (default: latest run on disk).
- `--node <id>` — node to pin the scenario to (default: the last failed
  `eval-gate` node, else the last failed/challenged node).
- `--out <dir>` — scenario output dir (default: `scenarios/promoted`).
- `--holdout` — also emit the sealed criterion file.

A run with nothing blocking it is an error (`NOTHING_TO_PROMOTE`, exit 1), not
a no-op — there is no failure to freeze.

## When NOT to promote

Promotion freezes a *signal*; only promote failures that say something durable
about the system:

- **Promote**: missing/stale evidence, a criterion that silently stopped being
  produced, a gate regression introduced by a real change.
- **Don't promote**: transient environment failures (network flakes, expired
  credentials, a crashed runner), runs blocked while the graph itself was
  mid-edit, or one-off incidents you already understand and fixed at the root —
  a committed scenario asserting an ephemeral condition becomes noise the gate
  re-blocks on forever.
