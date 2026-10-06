# P4 Gallery + Docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the template gallery honest and usable end-to-end — fix the labeled-vs-actual topology drift, close the params/inputs double-demand, give cook-plan a goal channel, surface structure in `gk template show`, let graph verbs accept `.gk.yaml` templates (preview without materializing), and refresh the stale docs surface.

**Architecture:** Templates stay `.gk.yaml` in `templates/gallery/`; the load path gets a discriminated `loadGraphDoc` (Graph vs GraphTemplate) so every graph-consuming verb either validates the template or offers a materialize hint — one branch point instead of scattered `kind === "GraphTemplate"` checks. The params↔inputs gap closes at materialize: interpolated values write through to `inputs.<name>.default` so `gk run start` doesn't demand them twice.

**Tech Stack:** TS + bun; existing `tests/unit/*` conventions.

**Spec:** `docs/superpowers/specs/2026-10-06-rearchitecture-design.md` §5 P4 + §47 (gallery: cook-plan, bench-eval, refactor-module keep; audit-pr→relabel, dream→relabel/fix sentinels). **Audit:** `.tmp-audit-rearch/gallery-templates.md` F1-F10, `.tmp-audit-rearch/SkillInitTemplate.md` F1-F13 + friction log. **Prereq:** P0-P3 landed at 0f0517e.

## Global Constraints

- Repo: `/Users/harry/Desktop/personal/graph-kit`, TS + bun. Test: `bun test tests/unit/<file>`; converge `bun run typecheck`. NEVER run lint/format/full suite per task.
- Commit per task; no docs/superpowers/, .tmp-*, .superpowers/.
- P0 resolver (`graph-resolve.ts`) is the only graph-input path — template-awareness hooks there, not per-verb.
- Every gallery change is verified by materializing + `gk validate` + `gk graph waves` on the result — a template that doesn't produce a runnable graph is not fixed.

## File map

- Modify: `templates/gallery/{audit-pr,dream,cook-plan,doc-sweep}.gk.yaml` (relabel/params/sentinels), `src/cli/graph-resolve.ts` (template pre-check → all verbs), `src/cli/commands/template.ts` (show → structure, materialize → write-through defaults), `src/schemas/template.schema.ts` (sentinel-default relax?), `kits/_core/skills/gk-init-graph/SKILL.md` (gallery list stale + init→execute friction), `docs/gk-slp-usage.html` + stale docs, kit prose.
- Tests: `tests/unit/template*.test.ts`, `graph-resolve.test.ts`, `graph-commands.test.ts`, gallery materialize e2e.

---

### Task 1: Template-aware graph input — `loadGraphDoc` + preview path (audit F1, F10)

**Files:**
- Modify: `src/cli/graph-resolve.ts` (one template-awareness branch feeding resolveGraph/resolveGraphPath), `src/cli/commands/graph.ts` (waves/ascii/svg/agents/gate accept .gk.yaml → materialize-in-memory to preview or clean TEMPLATE_NOT_GRAPH error with remedy), `src/compiler/validate.ts` or the template path (run agent-binding validation on the embedded `graph:` body too — F10)
- Test: `tests/unit/graph-resolve.test.ts` + `graph-commands.test.ts`

**Interfaces:**
- Consumes: `GraphTemplate` (kind === "GraphTemplate" with `graph:` body + `parameters`) vs `Graph`.
- Produces: `loadGraphDoc(path)` → `{ kind: "graph", graph } | { kind: "template", template }`; every graph-consuming verb calls it once — on template, materialize in-memory with `parameters` defaults (prompt-free) and continue the preview, OR fail `TEMPLATE_NOT_GRAPH` with `hint: "materialize first: gk template materialize <name>"`. Preview path (waves/ascii/svg/agents) should materialize-in-memory and print — no disk write, no `--use`. `validate` on a template runs BOTH template schema + the embedded graph's agent-binding checks.

- [ ] **Step 1: Write the failing test** — `gk graph waves templates/gallery/dream.gk.yaml` → previews waves (no SCHEMA_INVALID), no `.graphkit/graphs/` write; `gk validate` on a template with a typo'd agent → binding finding, not clean pass.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — loadGraphDoc in graph-resolve, wire into the verb set, template validate deepened.

- [ ] **Step 4: Verify** — `bun test tests/unit/graph-resolve.test.ts tests/unit/graph-commands.test.ts tests/unit/template*.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(cli): template-aware graph input — .gk.yaml previews without materialize; template validate checks embedded bindings`

---

### Task 2: Params→inputs write-through at materialize (audit F5)

**Files:**
- Modify: `src/cli/commands/template.ts` (materializeTemplate :278 area / substituteTemplate in template.schema.ts), `src/schemas/template.schema.ts`
- Test: `tests/unit/template*.test.ts`

**Interfaces:**
- Produces: materialize substitutes `{{param}}` AND writes the value to `inputs.<param>.default` in the emitted graph — `gk run start` on the materialized graph never re-demands a value the user already gave. If the template's `parameters` and embedded `inputs` both declare the same name, the materialized value wins as the default (user can still `--input` to override at run).

- [ ] **Step 1: Write the failing test** — materialize bench-eval `--params '{"workload":"W"}'` → emitted yaml has `inputs.workload.default: "W"`; `gk run start` accepts it without `--input`.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — after substitution, merge provided params into `inputs.<name>.default` on the emitted graph doc.

- [ ] **Step 4: Verify** — `bun test tests/unit/template*.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `fix(template): materialize writes params through to inputs defaults — no double-demand at run start`

---

### Task 3: Gallery honesty pass (audit F3, F6, F7, F8)

**Files:**
- Modify: `templates/gallery/audit-pr.gk.yaml` (diamond→adversarial-verification or correct chain label), `dream.gk.yaml` (diamond→correct label + `default:""` sentinels — F7), `cook-plan.gk.yaml` (add a `goal` parameter+input channel — F6), `doc-sweep.gk.yaml` (loop-until-done label vs hand-rolled node.loop — either label it correctly or convert to the declared idiom), all six: `recommendations.agents`/`skills` scrub (drop dup bindings + non-shipped skills — F8)
- Test: `tests/unit/` — materialize+validate+waves e2e per template

**Interfaces:**
- Per template: `topology` label = the actual shape (dream/audit-pr are chains — label `linear`/`custom`/`adversarial-verification` whichever the schema+shape match; check `gk graph inspect <topology>` for valid names); cook-plan gets `parameters: [{name: goal, required: true}]` + `inputs.goal` wired to the plan node's objective; `default:""` sentinels → schema relaxed (optional without default) OR templates omit the field; recommendations lists only shipped skills.

- [ ] **Step 1: Write the failing test** — a gallery test that materializes each template, validates, and asserts topology label == actual wave shape (a chain under `diamond` fails); cook-plan has a declared goal channel.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Fix each template** per the audit table; relax the `optional ⇒ default` schema rule if needed (F7 — decide: schema allows optional-without-default, or templates stay explicit — pick the honest fix).

- [ ] **Step 4: Verify** — the gallery e2e + `bun run typecheck`.

- [ ] **Step 5: Commit** — `fix(gallery): topology labels match shape, cook-plan goal channel, sentinel/duplicate scrub`

---

### Task 4: `gk template show` structure + init-graph prose (audit F9, SIT F3)

**Files:**
- Modify: `src/cli/commands/template.ts` (`runTemplateShow`), `kits/_core/skills/gk-init-graph/SKILL.md` (gallery list 4→6, the init→materialize→run friction the friction-log documents — `--use` + the `--params` recipe)
- Test: `tests/unit/template*.test.ts`, `pi-kit.test.ts`

**Interfaces:**
- Produces: `template show <name>` returns node ids, wave count, agent bindings, parameter names+required+defaults (not just counts); `gk-init-graph` prose names all 6 gallery templates + the real param workflow.

- [ ] **Step 1: Write the failing test** — `gk template show dream --json` returns `nodes`, `parameters[].name`, not just `parameterCount`.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — show renders the template's node table + params; SKILL.md gallery list + recipe refresh.

- [ ] **Step 4: Verify** — template tests + `gen-kits --check` + `sync-omp --check`.

- [ ] **Step 5: Commit** — `feat(template): show renders structure not counts; init-graph prose matches gallery`

---

### Task 5: Docs surface refresh

**Files:**
- Modify/delete: `docs/gk-slp-usage.html` (doc lie vs engine — retire or rewrite), `docs/graphkit.html` (CLI card/command count), `docs/gk-orchestration-report.html` (P2/P3-era stale), `docs/diagrams/gk-architecture.{html,json}` if residual, README (command table after T1-T3 shrinks it further), CHANGELOG P4 entries.

- [ ] **Step 1: Sweep** — `grep -rln "gk compile\|workflow\.js\|cbm\|gk-run\|graph index\|graph search\|graph ask\|graph trace\|graph query\|memory index\|dream\|audit-pr" docs/ README.md` — every stale doc section gets a superseded note or rewrite; `gk-slp-usage.html` retired or rewritten to the engine.

- [ ] **Step 2: Changelog** — P4 entries (template-aware verbs, params write-through, gallery fixes, show structure, docs refresh).

- [ ] **Step 3: Verify** — `bun run ci:local` full PASS.

- [ ] **Step 4: Commit** — `docs: P4 gallery+docs refresh — stale surfaces retired`

---

## Self-review

- **P4 spec coverage:** audit-pr relabel ✓ · dream relabel/sentinels ✓ · cook-plan reference (goal channel added — still the contract-richest template) ✓ · skills rewritten to real surface ✓ (init-graph + template + execute fixes from T1-T4) · SLP docs ✓.
- **Audit coverage:** F1 (T1) · F5 (T2) · F3/F6/F7/F8 (T3) · F9+SIT-F3 (T4) · docs (T5). **F2** (init defaults to .claude vs .omp) is a platform default decision — parked to the deferred list since changing the default is a product call. **F4** (three loop idioms) → T3 standardizes the gallery.
- **Ordering:** T1 first (template-aware input unlocks T3's verification); T2 independent; T3 needs T1 to verify; T4 independent; T5 last.
- **Deferred-carried:** everything from P2's list (I3 worktree verify, --resume, spawn dedupe, reduce/effort impl, hooks .cjs, gk exec judge, run round wiring) + P3's CLI-surface redesign + **F2 init default**.
