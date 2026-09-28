# OMP Orchestration Adoption — Design

Date: 2026-09-28 · Status: approved for planning · Source: `~/Downloads/OMP-Agent-Orchestration-High-Level-Design.md` (v1.0)

## Goal

Adopt the parts of the OMP orchestration design that graph-kit lacks, without importing machinery the doc itself defers or that omp already provides. Graph-kit is already the enforcement engine for ~80% of the doc (roles, ownership, wave barriers, worktree isolation, evidence fingerprinting, challenge adjudication); this design closes the remaining reliability and contract gaps.

Decisions locked with the user:

- `CHALLENGE: plan` — hybrid adjudication: orchestrator keeps adjudicating node challenges; plan-level challenges suspend for the human via the existing `gate` machinery.
- `landed` — `gk gate` can *require* it, not merely record it.
- Scope — all found gaps plus a `cook-plan` gallery template and eval-gate role hardening.

## Explicitly not building

SQLite state store, Herdr/Orca adapter abstraction, per-spawn timeouts on native `task`, ≤2-writer cap, fencing controller, persistent supervisor sessions, cross-worktree question mailboxes, escaped-defect reopening, token-cost estimation, question journal. Each is either subsumed by what shipped today (native `task` + hub + `gk_dispatch_agent` IS the platform layer) or explicitly deferred by the doc (§12).

## Design

### 1. Ledger: dispatch intent, `landed`, `attempt`

`src/memory/ledger.ts`:

- `TraceLine` gains two optional fields: `attempt?: number` and `landed?: { at: string; commit: string }`. Optional = old traces parse unchanged.
- New `dispatch.jsonl` per run dir: `{ node, attempt, at, via: "task" | "extension" }`. Written *before* dispatch — `gk run dispatch` on the skill path, emitted inside `gk_dispatch_agent`'s `dispatch()` on the extension path (it already owns run bookkeeping for timed-out kills).
- `reconcileRun` computes `dispatched − resolved` → `ResumeResult.unresolved: string[]`. A dispatched-but-quiet node is no longer indistinguishable from never-dispatched after a coordinator crash (doc §9 "launch response lost").

### 2. CLI verbs (`src/cli/commands/run.ts`, `evidence.ts`)

| Verb | Behavior |
|---|---|
| `gk run dispatch <node> [--attempt N]` | Append dispatch-intent line before launch. |
| `gk run land <node> --commit <sha>` | Stamp `landed` on the node's ok trace line. |
| `gk run node <id> --attempt N` | `attempt` on trace lines (replaces free-form notes convention). |
| `gk run take --from <id>` | Reconcile old run, verify no live dispatch pids, clear `.active`, stamp `takes_over` in new meta. `gk run status` surfaces `.active` age. |
| `gk evidence invalidate --key <k>` | Premise-supersession: marks evidence superseded even when the tree fingerprint is still fresh. |

`startRun` `.active` write → `wx` flag (atomic create; closes the check-then-write double-coordinator window).

### 3. Challenge protocol

- Grammar unchanged: `CHALLENGE: <node|plan> - <evidence>`.
- Disposition becomes a ledger fact: `gk run node <id> --status challenge --notes "disposition=accept|modify|reject|defer reason=…"`.
- `CHALLENGE: plan` suspends via existing `gate` human-approval machinery (graph.schema.ts gate field).
- `deriveResumeGraph` carryover: parent's unadjudicated challenges + last advisor event per pending node + steering notes flow into the derived graph's node refs. Closes "resume re-litigates settled questions."
- `analyze` counts dispositions → "design corrections" metric (§11).

### 4. Evidence & merge-protocol hardening

- SKILL.md evidence step: evidence written via `gk evidence add` so markers stamp at write. `gate.ts`: `freshness: strict` treats `unknown` as non-MERGE + warning (today markerless evidence silently passes strict).
- Worktree merge protocol (SKILL.md):
  - Post-merge owns check: merged `diff --name-only` ⊆ `owns` globs → abort before next merge.
  - Evidence re-stamp after merge commit (worktree evidence was fingerprinted against the branch HEAD).
  - Final-tree step: after the last merge, rerun the repo test suite on the main tree + `gk gate`. Node evidence keys were produced pre-merge; acceptance must be re-established post-merge.
  - Worktree timing: wave N+1 worktrees branch *after* wave N merges.
  - Merge abort recorded: `--status fail --notes merge-conflict:<branch>` → §11 "integration failures" metric for free.
  - `gk run end` payload lists orphaned `.graphkit/worktrees/*` + undeleted `gk/*` branches.
- `gate` gains `require_landed` — BLOCKs on ok-but-unlanded.
- Launch receipt: SKILL.md mandates a `hub jobs` snapshot showing one running row per spawned node before entering the wave wait; missing row = failed launch → record fail, stop.
- Message stamping convention: `run: <id> node: <id> rev: <graph_sha>` headers on hub sends / task items (SKILL.md text only).
- Constraint provenance: `constraints` entries accept `{ rule, source: human|author }`; default `author`. `source: human` constraints may not be modified by any agent.

### 5. `cook-plan` template + eval-gate role

- `templates/gallery/cook-plan.gk.yaml`: `plan → loop{implement, test}(max_rounds: 3, gate_evidence, no_progress_limit: 2) → eval-gate → integrate`. Doc §5's "3 total attempts" = `max_rounds` + `gate_evidence` + `no_progress_limit` composed; zero engine work.
- `eval-gate` role: currently a free-string convention consumed by `analyze.ts`. Promote to a documented role in the schema comment and SKILL.md; `gk validate` warns on unknown roles (advisory, consistent with existing `role: supervsor` advisory).
- Doc §5 Step 1's four-input separation (goal / constraints-with-sources / provisional choices / open questions) → the template's `plan` node writes constraints-with-sources into metadata; contract evidence keys get `depend_on` producers.

## Architecture boundaries

- All new state stays in the existing JSONL ledger. No new stores.
- `unresolved`, `landed`, `attempt`, `takes_over`, `disposition` are additive fields — no migrations.
- New verbs follow the existing `run.ts` subcommand dispatch pattern; dispatch-intent write is one function in `ledger.ts` shared by CLI and extension.
- Skill-contract changes live in `kits/_core/skills/gk-execute/SKILL.md`; host kits regenerate via `bun run gen:kits`.

## Error handling

- `take` refuses takeover if the old run's dispatched pids are live (never assume a dead coordinator).
- `land` on a non-ok line → `RUN_NOT_FOUND`-style error, no partial write.
- `wx` collision on `.active` → `RUN_ACTIVE` (same surface as today, just atomic).
- Strict freshness on `unknown` → BLOCK with a warning field naming the unstamped keys (actionable, not cryptic).
- Merge owns violation → same path as merge conflict: `git merge --abort`-equivalent stop, fail line recorded.

## Testing

Unit (temp dirs, existing test-rig style): dispatch-intent reconcile → `unresolved`; `landed` field parse + `require_landed` gate enforcement; `take` on stale `.active`; `wx` collision; `evidence invalidate`; disposition counting in `analyze`; `cook-plan.gk.yaml` passes `gk validate`; `eval-gate` role documented/validated. E2E: crash-mid-dispatch fixture → resume surfaces `unresolved` instead of double-dispatching.

## Risks

- `strict`-freshness change breaks graphs relying on `unknown` passing → mitigate: warning field names keys; `freshness: report` unaffected.
- `require_landed` opt-in; no existing graph enables it.
- Resume carryover adds refs to derived graphs — resume unit tests cover carryover shape.
