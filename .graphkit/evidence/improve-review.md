# Improve Review

## Verdict

**BLOCK.** `tsc`, build, CLI parity pass. Full suite: **483 tests, 14 failures**. All failures are regressions from the four reviewed commits.

## Prioritized fix list

- [ ] **[blocker] [fix-mechanical]** `tests/fixtures/minimal-diamond.yaml:30`, `tests/fixtures/valid-diamond.yaml:30`, `tests/fixtures/diamond-with-verification.yaml:35` — Fixtures still declare rejected `limits.max_workers`. This causes the waves golden, graph-subcommand, valid-diamond, full-flow, subgraph-composition, and dependent memory compatibility failures. The implementation contract is correct; fixture expectations are stale. **Fix:** remove the dead `limits` blocks from all three fixtures, then keep existing zero-findings/golden assertions unchanged.

- [ ] **[blocker] [fix-mechanical]** `tests/unit/waves-memory.test.ts:13-91` — All generated memory graphs are invalid under the newly authoritative validation path: they omit required `topology_config.inner.template`; `NO_CURATOR` also intentionally violates the existing `memory-curator-node` contract. Eight curator interleave tests therefore fail before scheduling. These tests previously passed only because `graph waves` bypassed validation. **Fix:** add `inner: { template: custom }` to valid memory graphs; replace the absent-curator “graceful” case with an assertion that waves returns `VALIDATION_FAILED`/`memory-curator-node`, or use a non-memory graph for the no-curator envelope case.

- [x] **[blocker] [fix-substantive]** `kits/claude/templates/custom.workflow.js:39-52` — A loop can return `{ok:false}` in an early round, then a success value later; only the final `loopResult` reaches the wave barrier. This violates fail-closed execution after an observable node failure. **Fix:** inspect each round result immediately; store/return on falsy or `ok === false` so later rounds cannot erase failure. Add a test proving round 1 failure prevents round 2 and downstream dispatch.

- [ ] **[suggestion] [fix-mechanical]** `tests/unit/custom-topology.test.ts:79-99` — Barrier tests cover `{ok:false}` only. The approved design explicitly requires thrown-agent and falsy-result behavior. Current tests would not pin two-thirds of the failure heuristic. **Fix:** add public workflow tests for a throwing `context.agent` and a falsy result; both must name the node and suppress downstream dispatch.

- [ ] **[suggestion] [fix-mechanical]** `kits/claude/skills/gk-execute/SKILL.md:66-68`, `kits/cursor/skills/gk-execute/SKILL.md:66-68`, `kits/codex/skills/gk-execute/SKILL.md:77-79`, `kits/pi/skills/gk-execute/SKILL.md:73-75`, `kits/opencode/skill/gk-execute/SKILL.md:74-76`, `.omp/skills/gk-execute/SKILL.md:73-75` — Old instructions remain and contradict the appended contract: they claim `stop_when` is evaluated and evidence is written per node ID, while the implemented contract says `stop_when` is advisory and requires one `<key>.md` per key. **Fix:** replace the old loop/evidence bullets; do not append a second competing procedure.

- [ ] **[suggestion] [fix-mechanical]** `README.md:13` — Intro still claims `limits` cap blast radius, while validation now rejects every `limits.*` field as unenforced. **Fix:** remove `limits` from the claim; retain only mechanically honest bounds.

- [x] **[suggestion] [fix-substantive]** `src/cli/commands/gate.ts:30-33` — Required evidence keys are joined directly into a path. Keys containing `/`, `..`, or absolute-path syntax can escape `outputs.evidence_dir`, violating the exact basename contract and allowing unrelated files to satisfy the gate. **Fix:** reject non-basename keys at schema/validation time (portable conservative pattern recommended), then add traversal and absolute-key tests.

## Confirmed good

- `src/cli/commands/graph.ts:704-837`: validated load, typed error preservation, incomplete traversal failure, valid output envelope retained.
- `src/cli/commands/gate.ts`: strict scoring, whitespace handling, byte count, SHA-256 manifest, exit-code contract implemented.
- `src/compiler/validate.ts`, `src/compiler/emitter.ts`, `.omp/extensions/gk-subagent.ts`: unsupported contracts rejected, dead limits serialization removed, `no_exec > tools_allowlist > no_write` implemented; pi installed/source copies identical.
- Kit gate text present across all seven required surfaces.
- Verification: `bun run typecheck` clean; build clean; CLI parity reports 27 reachable commands; `bun test` 14 failures.

## Evidence keys

- `fix_list`: 7 findings — 3 blocker, 4 suggestion.
- `review_verdict`: BLOCK
