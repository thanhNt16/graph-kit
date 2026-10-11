# GraphKit as a Software Factory

The software-factory release layers a production line on top of GraphKit's
compiled DAG + evidence gates: a backlog artifact the machine can verify,
budgets that refuse over-capacity work, a tamper-evident audit chain, and
context machinery that keeps long-running orchestrations truthful.

This document covers the features added for that release that do not have
their own dedicated page. See also: [scheduling](scheduling.md),
[holdout scenarios](holdout-scenarios.md), [loop kinds](loop-kinds.md),
[scored gates](scored-gates.md), [regression promotion](regression-promotion.md),
[trace evaluation](trace-evaluation.md), [context engineering](context-engineering.md).

## Feature list (`gk features`)

An Anthropic-style "initializer" artifact: a machine-checkable backlog that
survives context resets. Declare it on the graph, and gates refuse MERGE
while any item is still open.

```yaml
features:
  required: feature-list.json   # path to the backlog JSON
```

```json
{ "items": [
  { "id": "login-form", "description": "user can log in", "passes": false },
  { "id": "logout", "description": "user can log out", "passes": false }
] }
```

```bash
gk features list                    # show backlog state
gk features next                    # next open item (declared order)
gk features add --description "user can reset password"   # append a missing capability
gk features pass login-form         # mark an item verified (locked write)
gk gate                             # exit 1 while any item is open
```

Writes are guarded by an atomic lock directory so parallel workers cannot
clobber each other's completions; a stale lock is reclaimed after 15 s.

The backlog is writable mid-run, not only at init: an agent operating the
shipped software feeds each missing capability back with `gk features add`,
closing the operate→build loop. Appends land at the tail of the priority
queue, so `next` stays deterministic; `--evidence <key>` predeclares the
artifact expected to mark the item done.

## Run-level context budget

Declare a token budget for the whole run; each node's `budget_tokens`
reserves against it at dispatch time.

```yaml
budget:
  max_tokens: 400000
  warn_at: 0.7            # warn once 70% is allocated
```

```bash
gk run status            # → budget: {max, allocated, remaining, warn, exceeded}
```

Enforcement is real, not advisory:

* `gk run dispatch <node>` that would exceed the cap fails with
  `BUDGET_EXCEEDED` — the work is refused before any tokens are spent.
* `gk run end merged` refuses an over-budget run; end it `blocked`/`failed`.
* Materialized node-agent briefs include a `Context budget remaining` line
  so the worker knows its envelope before it starts.

## Tamper-evident run ledger (`gk run verify`)

Every ledger append is hash-chained to the previous entry, so a rewritten
history is detectable. Verify integrity at any time:

```bash
gk run verify                # re-check the hash chain of every run
gk run verify --evidence     # additionally confirm each referenced
                             # evidence file exists and matches
```

`--evidence` replays the recorded evidence references: a `<key>.md` marker
file that no longer exists (or never existed) is reported as a mismatch.

## Progress file (`## Progress so far`)

Long-running orchestrations lose the plot when context resets. The
`progress_tail` mechanism gives each node a recitation of what already
happened: `gk run progress` appends a line to `.graphkit/progress.md`, and
materialized briefs inject a `## Progress so far` section containing the
tail. The worker sees the run's recent history without re-deriving it —
the same "recite before acting" trick Anthropic describes for agents that
summarize-and-continue.

```bash
gk run progress --node build-api --status done --note "endpoints shipped"
```

## `fan_out.reduce`: deterministic merge & vote

A fan-out produces N parallel candidates; `reduce` collapses them into one
accepted artifact with an auditable record — no model judgment required
unless you ask for it.

```yaml
fan_out:
  count: 3
  reduce:
    strategy: vote        # vote | merge | first
    evidence_key: design  # which artifact is compared / accepted
```

* `vote` — majority hash: the artifact produced by >50% of workers wins;
  no majority → gate records a contested outcome instead of guessing.
* `merge` — union of all candidate artifacts into one file.
* `first` — take the earliest completed candidate (cheap tie-break).

The reduce outcome lands in the ledger with per-candidate digests, so
`gk run verify --evidence` can prove what each worker actually produced.

## Semantic no-progress (`no_progress_similarity`)

Fingerprinting catches byte-identical failures — but agents rarely fail
byte-identically. `no_progress_similarity` scores successive loop rounds
with Jaccard similarity over 3-word shingles of the round's output
fingerprint: two rounds that differ only in whitespace, timestamps, or
ordering still read as "no progress".

```yaml
loops:
  - nodes: [implement, run-tests]
    max_rounds: 5
    no_progress_limit: 2
    no_progress_similarity: 0.9   # rounds ≥90% similar count as no progress
```

Lower the value to catch more paraphrased stagnation; `1.0` degrades to the
old byte-identical fingerprint behavior.

## Continual learning (`gk learn`)

`gk evidence promote` freezes a blocked run into a regression scenario — but
freezing the failure doesn't explain why verification missed it. `gk learn`
is the second half of the loop: draft an improvement proposal, evaluate it
before adoption, and keep the adopted change reversible.

```bash
gk run end --status blocked
gk evidence promote --run <run-id>            # freeze the failure (optional but recommended)

gk learn propose --run <run-id> --note "gate never checked freshness"
# → .graphkit/learn/learn-<run-id>.yaml       (status: proposed)

# edit the proposal: fill hypothesis, proposal_kind, proposes.skill_path, fix
gk learn evaluate learn-<run-id>
# → verdicts per criterion linked in the source case, replayed over the
#   recorded evidence dir; when `fix` is recorded, it is applied in a
#   throwaway git worktree and re-run (evaluation.after_fix)

gk learn adopt learn-<run-id>     # only when status: evaluated and every
                                  # effective verdict passes (LEARN_FAILING)
gk learn reject learn-<run-id> --reason "fix costs more than the failure"
gk learn revert learn-<run-id>    # uninstall an adopted skill, status: reverted
gk learn list                     # all proposals with status
```

* `propose` auto-discovers the run's promoted `case.yaml` under
  `scenarios/promoted/` and links it as `source_case`; without one it warns
  and drafts anyway — proposals can precede the fixture.
* `evaluate` replays each linked criterion (`criteria/*.md` /
  `*.holdout.md` ids from the case's `failed_criteria`) against the recorded
  evidence dir with the same strict exists-and-non-empty read the gate makes.
  A recorded `fix` (`{kind: patch, value: <diff-file>}` or
  `{kind: command, value: <shell>}`) is rehearsed inside a temp git worktree
  so `after_fix` verdicts never touch the working tree.
* `adopt` is gated: status must be `evaluated` and every verdict in the
  effective set (`after_fix` when present, else baseline) must pass — else
  `LEARN_NOT_EVALUATED` / `LEARN_FAILING`. A proposal naming
  `proposes.skill_path` installs to `kits/_core/skills/<name>/SKILL.md` and
  re-runs the kit generator when `scripts/gen-kits.ts` exists
  (`adopted.kit_regen` records `ok` / `failed:*` / `needed` / `skipped`).
* `revert` removes the installed files and marks the proposal `reverted`, so
  adoption is always undoable.

## The gallery template

`gk template materialize software-factory` emits an 8-phase production line
combining every feature above: scout → architect → gated plan review →
feature-list build wave (parallel contract-bound builders) → integrate →
sealed holdout evaluation → bounded iterate loop → merge. It is the
reference implementation — copy it and prune what you don't need.
