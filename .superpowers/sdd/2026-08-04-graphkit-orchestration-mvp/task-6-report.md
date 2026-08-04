# Task 6 Report: Workflow Contracts, Submission, Parallel Fan-In, Human Resume

## Status

FIX ROUND 1 DONE. Commit `a5eae0c`.

## Test evidence (actual command output)

`cd apps/gk && bun test` → `108 pass, 0 fail` (11 files; includes 18 workflow integration tests).

Focused suite:
```
$ bun test tests/integration/workflow.test.ts
 18 pass
 0 fail
 69 expect() calls
Ran 18 tests across 1 file.
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

## Fixes per finding

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
- `fanoutTarget` heuristics (`save_as` match) are fragile for custom templates; explicit `from_agent` field on fanout node would be cleaner but schema change deferred.
- Evidence-key provenance / `required_evidence` still `[]` until Task 9.
