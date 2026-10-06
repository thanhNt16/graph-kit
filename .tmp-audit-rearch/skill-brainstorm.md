# Audit: kits/_core/skills/gk-brainstorm/SKILL.md (id: skill-brainstorm)

Tested against gk 0.3.34 (contract said 0.3.33) and the real root `graph.yaml` (320-line custom-topology graph), in `.tmp-audit-rearch/scratch-skill-brainstorm/` + `/tmp/session-test/` + `/tmp/t{A,B,C}.yaml`.

## Contract (as implemented)
- **Input:** an existing `graph.yaml` (hardcoded filename) + conversation.
- **Process:** read graph → `gk suggest --json` → `gk validate graph.yaml --json` (surface findings) → one-question-at-a-time dialogue (agents/models, model tiers, loops, constraints) → edit `graph.yaml` after EACH decision → one final validate → "suggest `execute`".
- **Output:** in-place mutations of `graph.yaml` written by the agent itself. No diff gate, no session-graph awareness, no named handoff command.
- **Handoff to init-graph: none in either direction.** init-graph never routes to brainstorm; brainstorm duplicates 4 of init-graph's steps (suggest-folding, binding questions, model tiering, validate) with none of its guardrails.

## Findings

### F1 — HIGH: skill teaches a dead constraint key (`assigned_only`)
- **Where:** SKILL.md:29 ("Add `assigned_only: true`") — the skill's ONLY constraint example.
- **Evidence:** `gk validate` on a graph carrying it → `{"valid":true,"warnings":[]}`. `grep assigned_only src/` → 0 hits. Real keys are `no_write`, `no_exec`, `tools_allowlist` (src/cli/node-agents.ts:30-52, src/compiler/validate.ts:311-326); the intended mechanism for "workers only touch assigned files" is `owns:` globs (graph.schema.ts:103-105, advisory; owns-overlap heuristic at validate.ts:268-283).
- **Why it hurts:** agents following the skill write config that silently does nothing and believe workers are file-scoped at execute time. The compiler tolerates unknown keys without even a warning, so the error is invisible end-to-end. False enforcement is worse than no enforcement.

### F2 — HIGH: file-model break — brainstorm edits the legacy path init-graph abandoned
- **Where:** SKILL.md:14,17,23-24 all hardcode `graph.yaml`; init-graph writes immutable session graphs (`.graphkit/graphs/<date>-<slug>.yaml` + `.graphkit/active`).
- **Evidence:** After init-graph, root `graph.yaml` doesn't exist — step 1 "Read the existing `graph.yaml`" fails; a compliant agent writes a fresh root file, forking the session graph. CLI resolvers then disagree: bare `gk validate` prefers the session graph (src/cli/graph.ts:98-109, session-first) while `gk run start` prefers root `graph.yaml` (src/cli/run.ts:95-100, root-first). Proven in /tmp/session-test: both files present → bare validate green on `sess-1`, `gk run start` recorded run `20261006-143610-root-fork`. `.graphkit/active` silently bypassed.
- **Why it hurts:** this is the init→execute seam. The skill's terminal step "confirm it passes before suggesting execute" can validate a different graph than execute runs. Refinement work lands in a fork the session pointer ignores.

### F3 — MEDIUM: no validate loop, no convergence protocol, no severity model
- **Where:** SKILL.md:17 (validate once, surface), SKILL.md:24 (validate once, "confirm it passes").
- **Evidence:** Skill never instructs fix→revalidate iteration or caps rounds. Severity unhandled: warn-only graphs pass (proven: duplicate-evidence warn → exit 0); refs-exist findings are blocking. Compare generic `brainstorming` skill, which encodes explicit revise-loop diamonds.
- **Why it hurts:** the loop terminates only because agents improvise; a literal agent validates once, sees residual warns, and either stalls or declares victory. Skill surface narrower than validated surface (`loops:` top-level groups have 4 validate rules — validate.ts:331-432 — never mentioned).

### F4 — MEDIUM: step 1 `gk suggest --json` is empty on fresh projects, no empty-case behavior
- **Where:** SKILL.md:15-16.
- **Evidence:** scratch (no ledger) → `{"count":0,"suggestions":[]}`; repo root (ledger history) → 2 reuse suggestions. Step originates from archive/superpowers/plans/2026-09-03-gk-memory-ledger.md:2299 ("gk-brainstorm + gk-init-graph — suggest as authoring input"), untested against the fresh-start case.
- **Why it hurts:** first-run experience (exactly the complained-about path) gets a dead step; a literal agent stalls or fabricates suggestions.

### F5 — MEDIUM: `gk graph inspect <topology>` dead-ends on custom — the topology refinement targets
- **Where:** SKILL.md:30.
- **Evidence:** `gk graph inspect custom` → `config_keys: []`; `inspect diamond` → 5 keys. Yet custom is what hand-authored/refined graphs use (root graph.yaml is custom), and custom nodes carry the richest config: loop, fan_out, retry, when, gate, effort, advisor, owns, budget_tokens, timeout_ms (graph.schema.ts:89-129).
- **Why it hurts:** the skill's designated config-discovery command returns nothing exactly where discovery is hardest; config knowledge lives only in schema source or init-graph prose.

### F6 — LOW: guardrail asymmetry vs init-graph (same operations, weaker subtype)
- **Where:** SKILL.md (whole) vs gk-init-graph Guardrails.
- **Evidence:** brainstorm changes agent bindings (no `gk inventory` check — invalid agent names surface only as validate agent-binding errors, proven), changes models (init-graph: "Model changes always require approval"; brainstorm: silent), overwrites per decision (init-graph: "Never overwrite an existing graph.yaml without explicit approval").
- **Why it hurts:** two skills performing one operation with different safety levels guarantees drift; users refined via brainstorm lose every guarantee init-graph establishes.

### F7 — LOW: vague terminal handoff — "suggesting `execute`"
- **Where:** SKILL.md:24.
- **Evidence:** no command, no skill invocation named. Three plausible referents: `gk run start`, the gk-execute skill, the native dispatch flow.
- **Why it hurts:** friction at the exact seam the re-architecture targets; the agent must guess the execute entry.

### F8 — INFO: overlap with generic `brainstorming` + 6-copy duplication
- **Evidence:** shared with host `brainstorming` skill: one-question-at-a-time, suggest-with-recommendation, decisions-folded-in, explicit next-phase handoff. Unique gk content ≈ 10 lines: 4 CLI calls + 3 hints (of which one is dead config (F1), one conflates the `loop-until-done` *topology name* with the node-level `loop:` field). Six byte-identical copies (kits/{_core,claude,cursor,codex,opencode,pi}); archived plan line 2225 mandates manual mirroring. Trigger collision: host skill demands use before "modifying behavior"; gk-brainstorm triggers on "brainstorm graph".

### F9 — INFO: cwd-relative validate noise
- **Evidence:** validating the real graph in scratch → 4 blocking refs-exist findings (refs resolve against cwd); in repo root → valid, 4 warns, exit 0. Skill gives no cwd guidance, so step 2 in the wrong directory sends the refiner chasing phantom findings. (Resolver behavior itself is CliSurface's surface.)

## Friction-log (user journey through this skill)
1. Locate the graph to refine — skill says `graph.yaml`; post-init-graph it's a session file; user/agent must resolve the discrepancy themselves.
2. `gk suggest --json` — dead on fresh projects (no ledger).
3. `gk validate graph.yaml --json` — cwd-sensitive; may emit environment noise as blocking findings.
4. N dialogue rounds, strictly one question at a time (bindings → tiers → loops → constraints).
5. In-place `graph.yaml` rewrite after EACH decision — no batching, no diff preview, no approval gate.
6. One final validate — no loop guarantee, no severity triage.
7. "Suggest execute" — user must already know the real execute entry point.
Minimum ideal path: ~7 steps, 3+ CLI calls, N conversational round-trips, ≥1 silent file mutation per decision. Nothing batches decisions or shows a consolidated diff.

## SOLID-lens
- **SRP:** "safely author/modify a graph" is split across two skills (init-graph creates, brainstorm mutates) with disjoint guardrail sets — one responsibility, two rigor levels.
- **OCP:** brainstorm hardcodes the legacy file model; the session-graph layering (init-graph, `resolveBareValidateGraph`) never extended it — skill text not closed against new graph storage.
- **LSP:** brainstorm is a behavioral subtype of init-graph's materialize+validate operation that violates its invariants (approval, inventory check, overwrite protection). "Refine via brainstorm" cannot substitute "re-materialize via init-graph" safely.
- **ISP:** skill interface = one filename; the CLI actually offers path-free resolution (bare validate, active pointer, `--graph` flags) the skill never exposes.
- **DIP:** constraint guidance binds to imagined compiler internals (`assigned_only`) instead of the real abstraction (`owns`/`no_write`/`tools_allowlist`); the compiler's tolerance of unknown keys hides the divergence.
- **Duplication (cross-cutting):** dialogue pattern re-implements the host brainstorming skill; 6 kit copies synced by manual mirror protocol, not build.

## Kill-or-keep (re-architecture recommendation)
- **KILL:** the `assigned_only` example (F1) — replace with `owns:` globs or `tools_allowlist`. Also kill the "loop-until-done" phrasing (topology-name/node-field conflation); say `loop: {enabled: true, stop_when: ...}`.
- **KILL as a standalone skill:** the body is ~80% re-implementation of the host dialogue pattern + init-graph steps at lower rigor. Merge "refine existing graph" into gk-init-graph as a mode: one authoring skill, two verbs (create/refine), one file model, one guardrail set.
- **MERGE spec for the refine mode:** operate on the ACTIVE session graph (bare-validate semantics); batch all decisions into ONE consolidated proposal; show a single diff for approval; apply by materializing a NEW session version + `gk graph switch` (preserves immutability); name the exact execute handoff (`gk run start` / gk-execute); fix-and-revalidate loop with blocking/warn triage.
- **KEEP:** validate-before-edit ordering; `gk suggest` folding (add empty-case behavior); model-tiering guidance (real and actionable); loop-config guidance (after F1/F5 fixes); `gk graph inspect` for canonical topologies.
- **For the init→execute friction goal:** the biggest win is making refinement non-interactive-by-default — validate + suggest + one consolidated diff + one approval — instead of N one-question rounds with per-decision rewrites. Secondary: unify graph resolution so validate and run start can never disagree (F2 is a CLI-level incoherence the skill merely exposes).
