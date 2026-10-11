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

## Task queue

`gk schedule` starts a whole graph on a cadence; `gk queue` is how discrete
work enters the factory between runs — a durable intake surface backed by
one YAML file per task at `.graphkit/queue/items/<id>.yaml`. An
orchestrator (or a human) appends tasks; worker sessions claim them in
dependency order; terminal outcomes are journaled back on the item itself.

```bash
gk queue add task.yaml            # or `-` to read the task from stdin
gk queue claim --node worker-3    # oldest item whose depends_on are all done
gk queue done <id> --evidence api-works,ui-works --note "shipped"
gk queue fail <id> --note "oom in build"
gk queue status                   # counts by state + blocked items
gk queue list --state queued
```

A task file is the work contract:

```yaml
id: build-api                # optional — task-<ts>-<hash6> is minted when absent
objective: ship the REST endpoints
acceptance_criteria: [api-works, tests-pass]   # strings — evidence keys the worker must produce
depends_on: [design-schema]                    # other task ids
budget_tokens: 50000                           # optional cap for the claimed work
graph: build-graph.yaml                        # optional graph path or template name
metadata: {priority: high}
```

Guarantees that make it safe to run unattended:

* **No duplicate execution.** `add` fails `QUEUE_DUPLICATE` when the id —
  or a content hash of the work contract — already exists in `queued`,
  `claimed`, or `done`. (`failed` doesn't hold an identity; a failed task
  may be re-queued.)
* **Dependency order.** `claim` hands out the *oldest* queued item whose
  `depends_on` are all `done`; `depends_on` must reference known ids at add
  time (`QUEUE_UNKNOWN_DEP`). A blocked head never starves later ready work.
* **Atomic claims.** Read-modify-write runs inside the same mkdir lock the
  feature list uses, so two workers can never claim the same item. An empty
  queue is not an error: `claim` emits `{claimed: null}`.
* **Honest terminals.** `done` requires a prior claim (`QUEUE_NOT_CLAIMED`)
  and records `--evidence` keys + `--note` on the item; `fail` leaves a
  `blocked` marker that `gk queue status` surfaces — failed tasks and the
  items stranded behind them.

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

## Learned-artifact lifecycle

`gk learn adopt` lands a `learned-artifact` memory file with an `adherence`
block (`adopted_by`, `anchor`, `use`/`view`/`patch` counters). The lifecycle
bounds that store — scoring is *uses when offered*, so idle time never ages
anything out:

* **Denominator** — every `gk recall`/`gk suggest` invocation appends one line
  to `.graphkit/memory/.requests.jsonl`; `anchor` snapshots its length at
  adoption, so `denom = requests − anchor` is opportunity-relative.
* **Probation** — `denom < lifecycle.maturity` (default 100 requests): live,
  unevictable, excluded from the capacity pool.
* **Graduation review** — past maturity with `use == 0 && view == 0` (never
  offered and never loaded) → archived with cause `graduation`;
  `graduation_suspended: true` parks the review.
* **Capacity** — mature pool over `lifecycle.capacity` (default 50) evicts the
  lowest `use/denom` rates (sha256(name) tiebreak → deterministic), cause
  `capacity`.
* **Archive, never delete** — eviction moves the file to
  `.graphkit/memory/.archive/<id>.md` (frontmatter + trace-log preserved);
  `gk memory revive <id>` moves it back with counters intact. Human-authored
  files (no `adherence` block, or `adopted_by: human`) are never eligible.

```bash
gk memory lifecycle [--dry-run]   # one lazy pass (also runs once per `gk run start`)
gk memory archive <id>            # manual move + ledger line
gk memory revive <id>             # restore under the live store
gk memory trace                   # report carries probation/mature/archived/
                                  # graduated/capacity_evicted counts
```

Archived members are invisible to recall/suggest/injection (the walk skips
dot-dirs); `absorbed_into` merges (curator/learn) stay distinct from lifecycle
eviction. Config lives at `topology_config.memory.lifecycle`
(`{maturity, capacity, graduation_suspended, expire_policy}` —
`expire_policy: lifecycle` hands adopted items to this flow instead of ACT-R
expiry).

Adoption also passes a deterministic admission lint (no model call, so the
text cannot argue its way past the gate). `LEARN_NO_EVIDENCE` fires when
`hypothesis`/`evidence` are empty — every learned mutation must cite the
episode that motivated it. Safety families (`injection`, `exfiltration`,
`destructive`, `persistence`) regex-scan the hypothesis, evidence, proposed
skill body and command fix; a hit is a hard `LEARN_LINT` reject. A missing
trigger cue (no `when:` phrase in the description) and skill bodies over 200
lines are advisory findings — they land in `adopted.lint` without blocking.
Every evaluate/adopt/reject/revert appends `{at, proposal, action, verdict,
families}` to `.graphkit/learn/.verdicts.jsonl`; `gk learn list` footers the
`{landed, rejected, reverted}` tally and `gk run status` gains a `learn`
section for the run's proposals, so rejections stay visible. Finally, node
briefs inject a `## Learned patterns` index (adopted proposals + memory items
stamped `adopted_by: "gk-learn"`, grouped by kind/category, ~20 newest
entries, `learn_index_tail: 0` to disable) alongside `## Progress so far`.

## Self-learning (AutoHarness port)

`gk learn` improves the graph between runs. `gk selflearn` (a TypeScript port
of [tigerless-labs/autoharness](https://github.com/tigerless-labs/autoharness),
MIT) improves the *skills agents carry* within and across sessions: agents
running under a gk kit distill durable lessons and funnel them through a
lint-gated admission pipeline — a self-improving factory with the same
capture → reflect → stage → promote → index mechanics as the original.

The pipeline is daemon-free and lazy: every step happens inside a host hook
invocation or a `gk selflearn` CLI call. It is deterministic everywhere
except the reflector, and the reflector can only *stage* — landing belongs
exclusively to the promote lint.

```text
transcript window ── capture ──▶ episodes/<session>.jsonl
      ▲ (PreToolUse tick, every N calls) │
      reflect_due ──▶ `gk selflearn reflect` ──▶ bundles/reflect-*.md
                                                  │ gk-reflector (read-only)
                                                  ▼
                                 intents/<id>.json  ── promote lint ──▶ landed SKILL.md
                                                  └─ reject ──▶ <id>.rejected.json
```

**capture** (`src/selflearn/capture.ts`) slices the host transcript from the
session's byte watermark to EOF, clips records to 4KB and the window to
200KB, redacts secrets/PII at egress (`redact.ts` — the autoharness rule
families), and persists the watermark under
`.graphkit/selflearn/watermarks/<session>.json`.

**stage** is the reflector's only emit path: `gk selflearn stage --intent
<json>` validates `{kind: create|update|patch|delete, target, reason,
evidence, body|old/new}` via zod and appends `intents/<id>.json`. Nothing
lands at stage time.

**promote** (`src/selflearn/promote.ts`, `lint.ts`) is the validating
admission gate and sole writer: it shapes each intent against the live
target in memory, runs the lint taxonomy (safety/exfil/injection/
destructive/persistence/network/obfuscation families, secret scan,
frontmatter structure, ≤60-char trigger-cued description, ≤25-line altitude
cap, placeholder ban, reason+evidence required, only-touch-self-produced),
then lands atomically — evidence slice first, `SKILL.md` last as the commit
point. Rejects get `.rejected.json` markers, never silent; `delete` archives
the whole skill dir under `.graphkit/selflearn/archive/`.

**index** (`src/selflearn/session_index.ts`) emits a `## Learned patterns`
grouped index (category → name: ≤60-char description) injected at session
start, plus a one-line `landed N, rejected M` digest of the previous drain
consumed once.

**Per target:**

- **claude** — `kits/claude/hooks/gk-selflearn.cjs` registered in
  `settings.json`: `SessionStart` injects the index via `additionalContext`,
  `PreToolUse` increments the per-session counter (crossing
  `SELFLEARN_REFLECT_EVERY_N`, default 50, sets `reflect_due` and instructs
  the session to run `gk selflearn reflect`), `Stop`/`SessionEnd` captures
  the window and promotes. `agents/gk-reflector.md` ships with
  `tools: Read, Grep, Glob, Bash` — no write tools; Bash is solely the
  `gk selflearn stage` emit path.
- **omp** — `kits/_core/extensions/gk-selflearn.ts` dispatches on the pi
  `session_start` / `tool_call` / `agent_settled` events and shells out to
  the same `gk selflearn` leaves, so the lint stays single-sourced. Skills
  land under `.omp/skills/` (`--target omp`); episode records arrive via
  `gk selflearn record` since omp streams no host transcript file.

```bash
gk selflearn status                      # episodes / staged / rejected counts
gk selflearn index                       # the injected learned-patterns index
gk selflearn reflect --session <id>      # materialize the reflector bundle
gk selflearn promote --session <id>      # drain staged intents through lint
```

## The gallery template

`gk template materialize software-factory` emits an 8-phase production line
combining every feature above: scout → architect → gated plan review →
feature-list build wave (parallel contract-bound builders) → integrate →
sealed holdout evaluation → bounded iterate loop → merge. It is the
reference implementation — copy it and prune what you don't need.
