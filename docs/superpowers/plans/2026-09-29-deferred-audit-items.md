# Deferred Audit Items — Fix Plan

Source: `docs/superpowers/specs/2026-09-28-e2e-audit-fixes-design.md` deferred list + audit findings `.tmp-audit/*/FINDINGS.md`. Each item is independent — dispatch in parallel where files are disjoint.

## Item 1 — Gate-level foreign-evidence lineage (spec gap → needs decision first)

**Finding:** resume reconciliation demotes evidence whose marker `run_id` isn't in the run's `resumes:` chain, but `gk gate`/`gk status` ignore `run_id` entirely — foreign evidence MERGEs. (AuditResume GAP-3, proven live.)

**Decision needed:** spec says "evidence overwritten by an unrelated run leaves the node pending" — that rule lives only in reconciliation. Either:
- (a) extend gate: under `freshness: strict`, a marker whose `run_id` is outside the active run's lineage → `foreign` freshness → BLOCK. Report mode → warning. Needs `resumes:` chain lookup in `gateGraph` (`src/cli/commands/gate.ts:~110`, ledger `listRunIds`/meta walk).
- (b) keep gate lineage-blind, document it: reconciliation is the only lineage enforcer.

**Recommendation: (a) under strict only** — strict already means "provable freshness"; lineage is the same class of check. Cheap: marker already carries `run_id`; walk `.graphkit/runs/*/meta.json` `resumes` field.

**Files:** `src/cli/commands/gate.ts`, `src/evidence/marker.ts` (freshness enum gains `foreign`), `tests/unit/` gate tests. **Risk:** runs started before marker run_id existed (legacy markers, run_id:null) must stay warn-not-block, or every old install breaks — treat `run_id:null` as `unknown` freshness, never foreign.

## Item 2 — Leaf `--help` (cac limitation)

**Finding:** `gk run dispatch --help` prints the run group's flattened options, not leaf help; cac routes `-h` to the parent command registration. (AuditCli F3.)

**Fix sketch:** intercept `--help` in each command's action before cac's own help handling is impossible — cac self-prints. Options:
- (a) Per-leaf usage text appended to each group's `Subcommands:` string in `subcommandsFor()` so the group help lists flags per leaf — cheap, no cac fight.
- (b) Custom `cli.command("run dispatch --help")`-style pseudo-registrations — fragile.

**Recommendation: (a).** `subcommandsFor` gains per-leaf option summaries; zero cac behavior changes.

**Files:** `src/cli/command-registry.ts` (`subcommandsFor`), group registrations in `src/cli/commands/*.ts`, `tests/unit/cli-trust.test.ts`.

## Item 3 — Bare group vs bare root exit-code asymmetry

**Finding:** bare `gk` exits 1 (F1: no command = usage error) but bare `gk run`/`gk graph`/… print curated help + exit 0. Deliberate (`models.ts:40` comment) but inconsistent with F1 rationale. (AuditCli F7.)

**Decision:** keep exit 0 on groups (arguably correct: a namespace isn't "no command") or align to 1. **Recommendation: keep 0**, document the asymmetry in `src/index.ts` F1 comment + cli-trust test comment — changing to 1 breaks muscle memory and scripts that probe `gk run` for availability.

**Files:** `src/index.ts` comment only. Effort: trivial.

## Item 4 — `docs/graphkit.html` validator claims drift

**Finding:** landing page lists a validate gate "Constraints: tools_allowlist and no_write rules" that didn't exist before (now partially exists post-FixGraph: wrong-shaped constraint values warn). Re-verify the full claimed checklist against `validateGraph` and rewrite the section to match reality. (AuditOrchFields F3-doc part.)

**Files:** `docs/graphkit.html` (~:489 section). **Effort:** trivial, prose only.

## Item 5 — `inputs` values: no executor consumption

**Finding:** `--input` values now land in run `meta.json` (0.3.32) but nothing substitutes them into node objectives (no `{{input}}` interpolation documented anywhere).

**Decision:** wire `{task}`/`{input.<name>}` interpolation into dispatch brief construction in the gk-execute skill text + materialized agents' objective rendering (`src/cli/node-agents.ts` — meta.inputs → `gk run inputs` read command?). Or document inputs as orchestrator-read-only provenance.

**Recommendation: document-only for now** — interpolation belongs in a spec change with template syntax decision; adding half an interpolation surface invites template bugs. **Files:** `kits/_core/skills/gk-execute/SKILL.md`, CHANGELOG note.

## Item 6 — dispatch.jsonl triple-line noise on extension path

**Finding:** extension dispatches write 3 intent lines (orchestrator `--via extension` + extension pre-spawn pid:null + post-spawn pid) vs 1 for task. Resume reconciliation consumes them fine, but the ledger is noisy.

**Fix sketch:** extension's pre-spawn `recordIntent` could skip when the orchestrator just wrote one for the same node+attempt within a small window — or simpler: skill text already says orchestrator records `--via extension`; dedupe identical consecutive `(node, attempt, via)` lines inside `recordIntent` (read last line, skip if same node/attempt/via/pid:null). 

**Recommendation:** skip — cosmetic, reconciliation already handles it, and dedupe adds read-before-write complexity to a path designed to never fail. **Won't fix; document in ledger comments.**

## Execution order

All items disjoint by file except none overlap — one parallel batch:
- Agent A: Item 1 (gate.ts + marker.ts + tests) — needs the run_id:null→unknown carve-out
- Agent B: Item 2 (command-registry.ts + group files + cli-trust test)
- Inline: Items 3 (comment), 4 (html prose), 5 (skill doc note), 6 (ledger comment)

Gate: `bun run ci:local`, then CHANGELOG + push if green.
