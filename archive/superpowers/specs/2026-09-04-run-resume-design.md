# gk run --resume — Checkpoint Replay — Design

Date: 2026-09-04
Status: approved design (brainstorm complete), pending implementation plan
Source: consolidated roadmap S1 (4-agent research: competitive, user-pain, internal, adjacent — 3/4 sources flagged resume)

## Problem

A run fails or is interrupted mid-flight (failed node, exhausted loop, killed session). Re-running the graph re-dispatches every node — re-spending tokens on work that already passed and overwriting good evidence. Every rival ships checkpoint/resume (LangGraph checkpointer, Agents SDK `RunState`, Temporal replay); the runtime design spec deferred resume pending the run ledger, which 0.3.0 shipped. The ledger already records everything needed — resume is the payoff.

## Non-goals

- Worktree/filesystem snapshot-restore (parking lot — Crab paper's atomic replay).
- Evidence content hashing (status + on-disk existence only, per user decision).
- `--from-wave` (`--from-node` + depend_on closure subsumes it).
- Runtime execution of anything — gk remains a compiler; the host's execute-skill dispatches the derived graph like any other.
- Cross-machine run continuation (paths are local).

## Decisions (user-approved)

| Fork | Decision |
|---|---|
| Surface | New derived session graph + waves payload; new run dir referencing parent — never mutate the old run |
| Satisfied rule | ledger `status: passed` AND evidence manifest paths exist on disk |
| Pending closure | `pending = ¬satisfied ∪ dependents(pending)` — stale downstream passes re-run |
| Upstream context | Replay: satisfied deps' evidence re-embedded into dispatch prompts (existing bounded 2KB-tail rule) |
| Drift | Refuse on graph mismatch (`RESUME_GRAPH_DRIFT`); `--force` overrides, event-marked |

## §1 CLI (`src/cli/commands/run.ts`)

```
gk run resume <run-id> [--from-node <id>] [--dry-run] [--force]
```

- Default pending set: every non-satisfied node (plus closure). `--from-node <id>`: pending = that node + its transitive dependents, regardless of satisfaction (explicit redo).
- `--dry-run`: print the reconciliation table (satisfied / pending / skipped-with-reason) and the would-be derived graph path; write nothing.
- Exit codes: 0 success (or dry-run, or nothing-to-resume informational); 1 error envelopes.

## §2 Reconciler (`src/memory/ledger.ts`)

Pure function over the run's ledger + graph:

1. Load `events` (run.md / trace) → per-node terminal status + evidence manifest.
2. Satisfied check per the rule above.
3. Compute pending closure over `depend_on`.
4. Graph drift: `meta.json` already records `graph_path` + `graph_sha256` at `run start` (since 0.3.0 — no new recording needed). Resume hashes the file at the recorded path and compares; mismatch or missing file → `RESUME_GRAPH_DRIFT`. The active graph is never consulted.

## §3 Derived artifacts

- **Graph**: `.graphkit/graphs/YYYY-MM-DD-<slug>-resume.yaml` — pending nodes only; each node's satisfied upstream deps become `refs` entries (evidence paths + keys). Collision suffix `-2`, `-3` per session-store convention. `--use` semantics: resume always sets it active (the point is immediate continuation).
- **Run**: new run dir; `meta.json` carries `resumes: <parent-run-id>` (and `run.md` shows `- resumes:`); `gk run status` prints the parent chain as `resumes_chain`. Advisor/fan-out/loop config copied verbatim into derived nodes.

## §4 Error handling

- `RESUME_RUN_NOT_FOUND` — no such run dir.
- `RESUME_GRAPH_DRIFT` — digest mismatch; hint names diverged nodes + `--force`.
- Parent run `end: passed` → informational exit 0 ("nothing to resume").
- Evidence manifest missing paths → those nodes are simply pending (not an error).
- All envelopes follow the existing `{status:"fail", error:{code, message, hint}}` shape.

## §5 Testing

- **Unit (reconciler)**: satisfied detection (status/evidence permutations), pending closure (diamond: dep fails → both downstream pending), drift detection, `--from-node` redo semantics, dry-run purity.
- **E2E (`tests/acceptance/run-resume.e2e.test.ts`)**: start → node A pass (evidence written) → node B fail → end failed → resume → derived graph contains B-closure only, A's evidence present as refs → B pass → end passed → status shows parent chain.

## Sequence

```
run ledger ──reconcile──▶ pending set ──derive──▶ resume graph (refs) + new run
    ▲                                                      │
    └──────────── host execute-skill dispatches ───────────┘
```
