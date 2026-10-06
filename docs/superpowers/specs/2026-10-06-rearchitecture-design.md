# GraphKit Re-architecture — Design Spec

**Date:** 2026-10-06 · **Status:** approved for planning
**Evidence:** 13-surface audit → `.tmp-audit-rearch/CONSOLIDATED.md` (374 lines; 2 CRITICAL, 29 HIGH, 26 MEDIUM, 25 LOW, 8 INFO findings, all scratch-verified).

## 0. Problem statement

Measured on gk/0.3.34: a 3-node template run takes **9 commands minimum, 19–24 following the skills literally, with 6–8 failure modes**. Per-invocation latency is ~100 ms — the friction is **procedural**: step count, hand-copied state, undiscovered prerequisites, and recovery.

Four structural root causes:

1. **`gk-execute` is an unwritten runner** — ~5 mechanical CLI calls/node where only the dispatch needs judgment; the runtime lives in 380 lines of prose.
2. **No Layer-1 contracts** — graph resolution ×3, validation at 3 gates of different strength, state split across ledger + a ghost `current.json` + fictional files in skill docs.
3. **Skill docs describe a CLI that doesn't exist** — `gk visualize`, `init-graph`, `assigned_only`, `current.json`, `{name}-result.json`; init-graph and execute skills disagree about graph identity.
4. **Dead weight** — `src/cbm` (backend 404s), `gk compile`/workflow.js, `.index` write-only log, 56 commands/~24 load-bearing, 5 host targets/1 verified.

## 1. Scope decisions (user-approved)

| Decision | Choice |
|---|---|
| Execution model | **Runner + judgment pauses** (Option B) |
| Runtimes | Kill the compile/workflow.js path; native task dispatch is the only runtime |
| Host targets | **pi + claude only** (codex/opencode/cursor dropped; fixable later via the target table) |
| Memory | **Shrink to run memory** — ledger + consolidate + recall; kill CBM bridge, PPR links, evidence-co-occurrence patterns |

## 2. Layered architecture

```
Layer-1 (contracts — singly owned, testable, in code)
├─ exec engine      wave walker + mechanical protocol + typed pause/resume
├─ event store      one append-only typed log → projections (trace, marker.md,
│                   run.md, status views); land = append event (kills lost-update)
├─ planGraph()      planner IR in compiler/ — waves + curator interleave +
│                   topology_config; waves/agents/ascii/svg/gate consume it
├─ graph resolver   ONE loader: path | session-id | active pointer | .gk.yaml
├─ input contract   ONE declared-input namespace (template params seed same-named
│                   graph inputs; enforced exactly once at run start)
├─ diagnostics      one envelope (fail⇒exit 1), GraphKitError everywhere,
│                   formatZodIssues → {path, message, hint}
├─ target table     pi + claude only: agent dirs, file extensions, tier maps
└─ memory           store + consolidate + recall (ledger files → src/runs/)

Layer-2 (projections — replaceable, thin)
├─ CLI verbs        ~11 thin verbs over L1
├─ skills           Tier-1 prose + GENERATED Tier-3 reference (command tables,
│                   checklists generated from the registry — never hand-written)
├─ gallery          3 honest templates: cook-plan, bench-eval, refactor-module
├─ gen-kits         consumes target table; emits pi + claude kits only
└─ gk-subagent      shrunk to {agent, objective, timeout_ms, node, attempt}
```

**Inversion rule (DIP):** Layer-2 never re-implements Layer-1 logic. Every HIGH audit finding traced to a contract re-implemented per-command, per-file, or per-skill. Skills and CLI verbs depend on contracts; contracts never depend on consumers.

## 3. The exec engine

`gk run exec [graph] --auto` owns the mechanical loop:

```
exec: validate → start(run) → waves(planGraph) → agents materialize → loop waves:
  ├─ wave barrier (task batch per wave; parallel inside)
  ├─ per node: dispatch intent → task spawn → trace → evidence stamp → land
  ├─ retry/backoff, timeout_ms routing → gk_dispatch_agent
  ├─ loop groups (round journal), advisor escalation, curator waves
  └─ PAUSE at typed decision points, emit ledger event:
       PAUSED:gate{node, question}            → resume on approval/reject
       PAUSED:challenge{target, evidence}     → resume on disposition
       PAUSED:when|stop_when                  → interactive asks; headless → Jev
       PAUSED:unresolved{nodes}               → takeover reconciliation
  → end → auto-gate (when required_keys) → auto-consolidate → report
```

- **Pause/resume is the event store.** `PAUSED:*` are ledger events; `exec resume` reads the log, so a crashed exec continues like today's `run resume`. The exec engine IS the orchestration runtime — it reuses `resume.ts`/`reconcileRun` logic rather than forking it.
- **Modes:** `--interactive` (default; emits JSON events, waits for resolution) vs `--headless` (Jev judges `when`/`stop_when`; gates auto-fail unless `--approve-gates`; challenges logged unadjudicated).
- **Manual protocol survives as documented fallback** until exec is proven; it writes the same event types, so manual↔exec runs interleave.

## 4. CLI surface (56 paths → ~11 verbs)

| Verb | Absorbs | Notes |
|---|---|---|
| `gk init [--target]` | init, new | one init installs `.omp/agents` + `.claude/` — kills two-init dance |
| `gk up [template\|topology] [--params J] [--input k=v]` | cold start → running graph | init→materialize→validate→exec in one call |
| `gk new <template\|topology> [--as ID] [--use]` | graph new/inspect/topologies, template materialize/list/show/switch | writes + activates session graph; `--list` covers both namespaces |
| `gk check [file]` | validate | thin read-only path sharing exec's validation |
| `gk run exec\|node\|end\|resume` | start/dispatch/node/land/end/resume/take/round | `node --evidence-file` fuses write+stamp (2N→N); exec is the engine |
| `gk status` | status + run status + analyze + suggest | `.active`-derived; `current.json` ghost deleted |
| `gk gate [file] [--html]` | gate + evidence report | `--html` path in envelope; `run end` invokes when required_keys |
| `gk evidence add\|invalidate` | evidence verbs | `--node` wired or cut |
| `gk ask <query> [--explain]` | memory recall | explain built in; sole memory read surface |
| `gk models [target] [--map k=v] [--reset]` | models ×5 | grammar normalized to verb + flags |
| `gk draw [file] [--svg]` | graph ascii/svg | viz-only; no execution-contract role |

**Killed:** `gk compile` + workflow.js, `src/cbm` + 6 commands, `suggest`/`run analyze`/`evidence report`/`memory index|trace|touch` as verbs, `graph show` (`ascii/svg` → `draw`), `template list/show/pack` (folded into `new`).

## 5. Migration phasing

Each phase independently shippable, on a feature branch, `ci:local` gate per phase.

- **P0 — Contract extraction:** one graph resolver everywhere; one error path; `run start` validates before state creation; validate↔agents agreement via target table; `evidence --node` wired.
- **P1 — Event store + planner IR:** merge ledger + evidence store into typed event log; `land` = append (kills read-modify-write race); `planGraph()` extracted from graph.ts:821-963; `current.json` deleted.
- **P2 — Exec engine + fused verbs + `gk up`:** the flagship phase; exec ships behind `--auto` first; skills regenerated as thin prose + generated reference.
- **P3 — Memory shrink + dead weight:** cbm/compile/.index/PPR/co-occurrence killed; ledger→`src/runs/`; consolidate merge-retain fix; pi+claude kits only.
- **P4 — Gallery + docs:** 3 honest templates fixed (audit-pr→relabel, dream→relabel/fix sentinels, cook-plan keeps as reference); skills rewritten to real surface; SLP docs refreshed.

## 6. Testing & risk

- **Exec engine:** E2E per topology (diamond, loop, fan_out, gate-pause, challenge-pause, takeover-resume) with stub dispatches; pause/resume invariants (crash mid-wave → `exec resume` replays identically); property test: manual protocol and exec produce identical event logs.
- **Regression:** 766-test suite stays; new tests only where audits proved bugs (event-store atomicity, resolver equivalence, input fusion, consolidate merge-retain).
- **Risk ranking:**
  1. Exec-engine semantics — mitigated: pause events are ledger events; resume reuses `resume.ts`; manual protocol stays as fallback.
  2. Event-store migration — readers accept both old and new layouts during transition.
  3. Skill regeneration — generated reference can't drift silently; a `--check` gate diffs generated vs committed output.
  4. Target-table freeze (pi+claude) — codex/opencode/cursor dropped cleanly; re-adding is a table row, not a code path.

## 7. Kill / keep (summary)

Kill: `current.json`, `src/cbm`, `.index` dual-schema log, `gk compile`+workflow.js, PPR/co-occurrence, gk-brainstorm as standalone skill, gk-eval memory/both docs, dead keys/fictional commands in skills, decorative `--json` flags, `run dispatch|land|take|round` as separate paths, `models`×5 leaves, `init` vs `new` duplication.

Keep (verified load-bearing): kit materialization pipeline (E2E-clean), node-agents materializer, gen-kits staged swap + both `--check` gates, `.active` wx-exclusivity + dangling recovery, fingerprints + content-addressed artifacts, `.strict()` schema default + Finding severity model, `topoWaves` seam, gk-subagent kill semantics, ADR-002 basename contract, recall `--explain` lens, run ledger + resume/take, gate + `run end`-invocation.

## 8. Skill architecture (SOLID-in-skills frame)

- **Layer-1 skill contract (abstract):** the gk runtime itself is the contract — skills describe intent, never mechanics. `gk-execute` shrinks to "run `gk run exec`, respond to PAUSED events" — ~40 lines.
- **Layer-2 (detail):** Tier-3 references generated from the registry (command tables, parameter contracts, checklists) — zero hand-written command docs. `gen:skills` emits them; a `--check` gate prevents drift.
- **Progressive disclosure:** Tier-1 name+desc (skill discovery) → Tier-2 SKILL.md (intent prose) → Tier-3 generated reference (mechanics on demand). Skills may not embed repo-internal paths or fiction.
- **One authoring skill:** `gk-init-graph` absorbs `gk-brainstorm` as `refine` mode — one file model, one guardrail set, batched decisions → one diff → one approval → session version + switch → named execute handoff.
