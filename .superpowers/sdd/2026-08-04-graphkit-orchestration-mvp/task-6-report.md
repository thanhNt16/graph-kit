# Task 6 Report: Workflow Contracts, Submission, Parallel Fan-In, Human Resume

# Task 6 Report: Workflow Contracts, Submission, Parallel Fan-In, Human Resume

## Status

FIX ROUND 3 DONE. Commit `d55bcca` (implementation). Prior: `fbdd78d`, `a5eae0c`, `964ce0c`.

## Test evidence (actual command output — Round 3)

```
$ bun test tests/integration/workflow.test.ts
 22 pass
 0 fail
 86 expect() calls
Ran 22 tests across 1 file.

$ bun test
 112 pass
 0 fail
 288 expect() calls
Ran 112 tests across 11 files.

$ bun run typecheck   → OK (tsc --noEmit clean)
$ bun run lint        → OK (biome check, 35 files, no fixes applied)
$ bun run build       → OK (dist/index.js, 5 modules)
```

## Fixes per finding (Round 3)

1. **CRITICAL — concurrent join/next race fixed (stale-mutation guard).** `mutateRun` accepts an optional `skip` result: when the join/router mutator detects `d.run.current_nodes[0] !== captured current || status !== "running"`, it returns documents unchanged with `skip: true` — no event, no checkpoint, no iteration increment. Caller re-reads/recurses so the returned contract reflects the actual current node. Test "concurrent next at join advances exactly once": `max_iterations: 1` (would prematurely `limit-exceeded` on double-advance), two `Promise.all(next, next)` → both agent contracts, `current_nodes` stays `summarize`, `iteration` increments exactly once, exactly one join `command` event/checkpoint.

2. **CRITICAL — post-dispatch expiry deadlock fixed (fanout-authoritative dispatch).** Dispatch now keeps `current_nodes` on the fanout, not the worker — the fanout stays the dispatch authority so the expiry-recovery branch is always reachable at `next`. `submitWorkflow` resolves the submitting worker via the lease record (`d.leases.find(id).node`) while the cursor remains on the fanout; non-fanout agent behavior unchanged (lease absent → current node). Tests: "waits at fanout while one required item remains in flight" (empty-wait dispatch before expiry); new "post-dispatch expiry reissues while fanout remains authoritative" (dispatch → stale lease via time-rewrite → next reissues fresh lease, cursor stays `fan`, distinct lease ID); "expired in-flight lease is recovered…" still green (old lease `status: "expired"`, reissue, old submit rejected `LEASE_EXPIRED` with reject event code/actor/lease/node).

3. **REJECTION GAP closed.** Missing output-schema path now wraps in `rejectEvent(SCHEMA_VIOLATION)` before throw; submit catch handles every GraphKitError uniformly; pre-lock non-agent/unknown-target also logged. Human paused-node submission re-allowed via `status === "paused" && human` guard in the mutator.

## Files changed (Round 3)

- `src/runtime/store.ts` — `MutationResult.skip` opt-out (skip event/checkpoint inside `mutateRun`)
- `src/commands/workflow.ts` — stale guard on join/router; fanout-authoritative dispatch; lease-driven submit node resolution; schema-miss reject logging
- `tests/integration/workflow.test.ts` — +2 tests (join race, post-dispatch expiry), 22 total

## Concerns

- `MutationResult.skip` is an internal escape hatch; only the join/router stale path uses it. Store unit tests unaffected.
- Cursor-on-fanout means chain (non-fan) agents resolve submit by cursor; fan workers resolve via lease. Getting the distinction wrong in a future caller would silently target the wrong node — documented in `submitWorkflow` comment block.
- `fanoutTarget` untargeted-agent topology heuristic retained; `required_evidence: []` until Task 9.

---

## Status (Round 2)

FIX ROUND 2 DONE. Commits: `fbdd78d` (implementation), `5ecb33a`/`a5eae0c` (prior).

## Test evidence (Round 2)
## Test evidence (actual command output)

`cd apps/gk && bun test` → `110 pass, 0 fail` (11 files; includes 20 workflow integration tests).

Focused suite:
```
$ bun test tests/integration/workflow.test.ts
 20 pass
 0 fail
 76 expect() calls
Ran 20 tests across 1 file.
```

Gate checks:
```
$ bun run typecheck   → OK (tsc --noEmit clean)
$ bun run lint        → OK (biome check, 35 files, 1 info)
$ bun run build       → OK (dist/index.js, 5 modules)
```

## Files changed (Round 1)

- `src/commands/workflow.ts` — major rework of fanout dispatch, lease recovery, provenance
- `src/runtime/leases.ts` — `LEASED_EXPIRED` check evaluates `status === "expired"` before "already settled"
- `src/schemas.ts` — `LeaseStatusSchema` includes `"expired"`
- `tests/integration/workflow.test.ts` — 5 new tests + actor assertion

## Fixes per finding (Round 2)

1. **HIGH — join→agent deadlock fixed.** `nextWorkflow` join/router case now persists the transition under `mutateRun` via `advance` (set current_nodes to the chosen successor, apply iteration/failure counters, checkpoint/event) and recurses. The returned agent contract reflects the real current node. Idempotency preserved: repeated `next` after join advances only once (next call sees unsubmitted agent and returns its contract, never re-advancing). Aggregator test now full-cycle: settle fanout → next returns `summarize` agent contract → submit via contract success → `state.result` saved, run advances to `done`.

2. **REJECTION EVENT centralized.** `submitWorkflow` catch now calls `rejectEvent` for every GraphKitError (previously only lease codes); reject helper stamps `type: "reject"`, `node`, `lease`, `actor` (defaults "system" for `INVALID_TRANSITION`), `details.code`, `details.work_item`. Late-submit test asserts reject event content, not only thrown code.

3. **Submit event + checkpoint provenance lease/actor verified.** New test reads event log and newest checkpoint: worker submit carries `type: "submit"`, `node: "work"`, `lease`, `actor: "worker"`; checkpoint `provenance.actor`/`provenance.lease` match.

4. **`dispatchContract` comment updated** — "Call under the run lock" (was misleading "Pure").

5. **Unambiguous fanout worker resolution.** `fanoutTarget` now computes agents targeted by any non-fanout edge; requires exactly one untargeted agent candidate or throws `SCHEMA_VIOLATION` — no first-agent fallback. Ambiguity test: two untargeted agents → `SCHEMA_VIOLATION` on `next`.

6. **Poll/expiry preserved** (from Round 1): expired in-flight lease marked `status: "expired"`, removed from `in_flight`, reissued under fresh lease; old lease submission rejected `LEASE_EXPIRED` + reject event. No deadlock.

7. **Dead code removed.** Unused `deterministicOrAgent` deleted (join/router persist via `advance` + recursion). `stripInputs` retained for agent context output.

## Concerns

- `fanoutTarget` topology heuristic (untargeted-agent scan) is robust for current templates; explicit `from_agent` schema field would be cleaner but deferred.
- `rejectEvent` / `submit` events use existing Event enum; extended provenance types beyond `EventTypeSchema` not added.
- `required_evidence` still `[]` until Task 9.

---

## Fixes per finding (Round 1)

1. **CRITICAL — premature join eliminated.** `fanIsComplete` now requires ALL original items to be `settled` (not in-flight). If items remain in flight, `nextWorkflow` returns a dispatch contract with `items: []` (wait/poll), keeping `current_nodes` on the fanout node. Test "waits at fanout while one required item remains in flight" proves this.

2. **IMPORTANT — concurrent next double-issue fixed.** Entire dispatch decision, including lease issuance and expiration recovery, now happens inside a single `mutateRun` call — leases are computed and persisted under the same directory lock. `Promise.all(nextWorkflow, nextWorkflow)` produces disjoint active leases per work item. Test "concurrent Promise.all next calls never double-issue a lease" verifies union of dispatched `work_item` IDs are unique. One of the two calls returns an empty dispatch wait contract when the other consumed the free slots.

3. **IMPORTANT — expired lease recovery.** `recoverExpiredLeases` runs at the start of every locked fanout dispatch: expired active leases are marked `status: "expired"`, removed from `in_flight`, and eligible for re-issuance under a fresh lease. `validateLease` now checks `expires_at`/`expired` before `settled`. Test "expired in-flight lease is recovered, reissued, and old submission rejected" proves: old lease `status: "expired"`; fresh lease has distinct ID; submission against old lease returns `LEASE_EXPIRED` + reject event. Dead workers no longer deadlock the fanout.

4. **MINOR — join to aggregator agent.** `deterministicOrAgent` now receives `loaded`, `run`, `next`, and `state` — returns full agent contract when next node is an agent: objective, context (inputs+state), real `output_schema`, `output_save_as`, tool_allowlist, exact submit argv. Empty schema placeholder removed. Test "join advances to aggregator agent with full contract" covers 2-agent workflow (worker + summarizer), `fanoutTarget` resolves via `save_as == fan.from` matching.

5. **MINOR — submit provenance and late-submit gate.** `submitWorkflow` checks `run.status === "done"` or missing node before validation, returns `INVALID_TRANSITION` + reject event. Agent/fan/human submits stamp `event.type: "submit"` with actor and lease. Checkpoint provenance captures lease + actor for all code paths. Test "submit after run advanced to non-agent node is rejected with provenance" verifies late submit does not mutate.

6. **Remove dead code.** Removed unused `void workflow` / `void lease` / unused `leases` destructure in `nextWorkflow`. DeterministicContract `output_schemas` and `output_save_as` kept optional for symmetry; genuinely unused fields trimmed. `fanIsComplete` predicate is the single source of truth for join-gate logic.

## Design notes (updated)

- Fanout target resolved by matching `save_as` to `fan.from`, not global agent count — allows multiple agent nodes in one workflow (e.g. worker + summarizer). `emptyDispatch` creates a wait/poll contract rather than a no-op pass-through.
- Expired leases are **marked, not deleted**: status `"expired"` is a first-class state, visible for audit. `validateLease` checks expired before settled so expired+settled sequences fail correctly.

## Concerns

- 2 concurrent `nextWorkflow` calls: one gets leases + changes current_nodes to agent; the other re-reads after lock release and sees `current_nodes=["work"]` → returns agent contract via `nextWorkflow` recursion. Second stuck call may return dispatch or agent. Test proves leases union unique.
- Evidence-key provenance / `required_evidence` still `[]` until Task 9.
