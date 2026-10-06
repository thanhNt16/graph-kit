# compiler-schema audit — src/compiler/* + src/schemas/*

Scope: validate.ts, resolver.ts, emitter.ts; graph/eval/memory/template schemas; topology/index.ts. Empirics run in `.tmp-audit-rearch/scratch-compiler-schema/` (cleaned up).

## Findings

1. **HIGH — `gk run start` performs zero validation.** `run.ts:159-188` → `ledger.ts:118-191`: startRun only checks file existence and reads `metadata.name` for the run id. Proven: `graph-bad.yaml` (unknown top-level + node fields) started a run, exit 0, ledger dir created. Schema failure surfaces only at the next step (`gk graph waves|agents`), by which time a run is active and must be `gk run end`/`take`-ed before restart. Biggest single init→execute friction: errors discovered 2 steps late, with cleanup tax.
2. **HIGH — validateGraph false-passes before `gk init`.** `validate.ts:26-36,48`: agent-binding check is skipped entirely when no host agent dir exists (`if (agentDir && ...)`). Proven: graph binding `software-architect` returns `valid:true`, zero warnings, in a dir with no `.omp/agents`. The guarantee "validate ⇒ dispatch finds agents" doesn't hold; AGENT_NOT_FOUND first appears at execute time (`node-agents.ts:76-84`).
3. **HIGH — no intermediate representation; the real IR lives in the CLI.** Pipeline: YAML → zod `Graph` (types only) → `Finding[]` (validate) → JS source *string* (emitter). But the default runtime never compiles: `kits/_core/skills/gk-execute/SKILL.md:15` — "there is no compile step in this kit". The actual execution IR is the waves payload built inline in `cli/commands/graph.ts:821-963` (~140 lines: curator interleave, nodeObj mapping, raw-doc re-read). It's in the CLI layer, unversioned, untestable in isolation, consumable only by pasting into an orchestrator context. `emitter.ts`/`resolver.ts` serve only the legacy Claude-Workflow path (`gk-run` skill, `.claude/workflows/`).
4. **HIGH — waves payload drops `topology_config`.** `graph.ts:940-961`: payload carries graph/topology/waves/evidence/hooks/warnings + a memory-only sub-object. routes/refuters/survive_threshold/candidates/judge never ride it. The native orchestrator receives flat waves for classify-and-act / adversarial / tournament graphs; gk-execute SKILL.md has zero topology-specific orchestration (grep: one passing mention). Topology semantics exist only inside `.workflow.js` templates — `topology:` is near-decorative in native mode.
5. **MEDIUM — `topology_config` is `z.any()`, and the keys table is docs-only.** `graph.schema.ts:202-204`: `z.record(z.string(), z.any())`. `topology/index.ts:17-38` `TOPOLOGY_CONFIG_KEYS` consumed only by `graph topologies|inspect` display (grep: zero enforcement). A typo (`refuter`, `survive_treshold`) passes validate and is silently ignored at runtime. `memory` is the only validated sub-config (schema superRefine :205-217).
6. **MEDIUM — agent-binding rule implemented twice, divergently.** `validate.ts:18-20` `agentFileName` normalizes to kebab-case; `node-agents.ts:76` looks up raw `${node.agent}.md`. Proven: `agent: Software Architect` → validate ok; `gk graph agents` → `AGENT_NOT_FOUND` looking for `Software Architect.md`.
7. **MEDIUM — validateGraph mixes pure shape checks with environment probes.** fs.exists on refs (:57-65), criteria registry files (:177-194 incl. YAML frontmatter parse :185), agent-dir listing (:26-36). Consequence: `memory/resume.ts:234-242` had to hand-build `validateDerivedGraph` because disk-state rules don't apply to derived graphs — a second, hand-maintained subset of the validator (drift risk documented in its own comment).
8. **MEDIUM — compiler imports CLI.** `validate.ts:4` imports `topoWaves` from `../cli/graph-waves.js` — dependency direction inverted. `graph-waves.ts` is pure Kahn levelization mis-homed in cli/ (its header admits it's "shared by the executor and the renderers").
9. **MEDIUM — six hand-rolled zod-issue formatters, two error conventions.** Structured `GraphKitError`+details: `graph.ts:68-71`, `store/index.ts:153-156`, `template.ts:88-96`. Plain `Error` with `CODE: joined-string`, code re-extracted by regex: `run.ts:72-79` + `errCode` `run.ts:55-59`, `loops.ts:80-83`, `resume.ts:103-106,238-242`. Run-surface agents get `SCHEMA_INVALID: path: msg; ...` — no details object, no available-values.
10. **LOW — SCHEMA_INVALID messages don't help agents fix the doc.** Proven: unknown top-level key → `{"path":"","message":"Unrecognized key: \"unknown_top_field\""}`. Empty path, no "did you mean", no nearest-known-key hint. Zod has everything; the mapping keeps only path+message.
11. **LOW — graph.ts is a 1077-line god-file.** ~515 lines of embedded YAML scaffolds (:112-627) + one action with a 13-branch if-chain (:629-1077). run.ts same pattern (448). Maintenance friction, not runtime friction.
12. **LOW — name collision: two `materializeTemplate`s.** `schemas/template.schema.ts:211` (pure substitute + `GraphSchema.parse`) vs `cli/commands/template.ts:278` (materialize + validateGraph + session save + --use). Same name, different semantics, both exported.
13. **INFO — waves bypasses the schema it just ran.** `graph.ts:834-839` re-reads raw YAML for `role`/`eval` because `GraphSchema.parse` materializes EvalConfig defaults. The IR mixes parsed and raw data — symptom of the schema doing double duty (validation + default materialization) with no author-view/effective-view split.
14. **INFO — wave computation duplicated inside validate.ts.** §7b uses `topoWaves` (:267); loop_contiguous (:391-412) re-implements memoized-DFS waves inline instead of reusing it.

Answers to the brief:
- **What compile produces**: a concatenated JS source string (meta export + inlined kit `.workflow.js` sources with `export ` stripped + JSON graphConfig + factory call + `return await _wf(_ctx)`) written to `.claude/workflows/<name>.workflow.js` (`emitter.ts:25-73`, `graph.ts:669-674`). Consumed only by Claude's Workflow tool via the gk-run skill.
- **Where the graph goes after validate**: nowhere as a value. `Finding[]` out; every consumer re-reads + re-parses YAML from disk (waves: `loadGraph` + `readGraphDoc`; run start: `graphName` + `requiredMissing` + `startRun` = 3 parses; a full init→execute ≈ 5 YAML parses). No IR.
- **Schema strictness**: known objects `.strict()` (unknown keys hard-fail); `metadata`/`inputs` intentionally `.passthrough()`; `topology_config` wide open (F5).
- **Topology templates vs freeform**: `custom|sdd|superpowers|research-and-build` alias to `custom.workflow.js` (emitter `TOPOLOGY_TABLE`); subgraph refs recurse to canonical templates only (`resolver.ts:20-23`, depth ≤ 3). Freeform graphs get zero topology semantics in native dispatch (F4).

## Friction-log (goal → running graph, this surface)

1. Author graph.yaml — via `gk graph new <topology>` (stdout scaffold to redirect), `gk template materialize --use`, or by hand.
2. `gk validate [file]` — optional; skipped by most skill flows until dispatch prep. Pre-init: agent binding silently unchecked (F2). No compile-check loop incentive because native path doesn't compile.
3. `gk run start --graph X --json` — no validation (F1); `RUN_ACTIVE` from a stale run blocks and requires `gk run take --from <id>` first; required inputs enforced here (MISSING_INPUTS) — the only check that IS at start.
4. `gk graph waves X --json` — first place a schema-invalid graph fails; WAVES_INCOMPLETE for cycles the schema already rejects (dup cycle detection); warnings ride along (good).
5. `gk graph agents X` — first place missing `.omp/agents` (AGENT_DIR_MISSING → "run gk init"), missing base agent fragment (AGENT_NOT_FOUND), or case-mismatched agent names surface (F6).
6. Orchestrator loop: `gk run dispatch` per spawn → `gk run node --status …` → `gk run land --commit` → `gk run end`. Failure mid-loop stops the graph; retry/when/gate re-checked from the waves payload by the model.

Pattern: the three validation gates (schema, semantics, environment) are spread across steps 2/4/5 with different guarantee strengths; step 3 — the one that creates state — validates least. Fix cost rises monotonically with step number.

## SOLID-lens

- **SRP**: `validateGraph` = 3 jobs (shape, graph semantics, environment state) → forced `validateDerivedGraph` fork (F7). `graph.ts waves` = execution planner living in a CLI command (F3). `graph.schema.ts` itself is cohesive — 306 lines that ARE the Graph contract; eval/memory already factored out; the "constraints/eval/advisor/loop all in one file" worry is overstated at file granularity.
- **OCP**: adding a topology touches ≥4 places: `TOPOLOGY_NAMES` + `TOPOLOGY_CONFIG_KEYS` (schemas/topology), `TOPOLOGY_TABLE` (emitter — exhaustiveness-checked, good), `graphTemplate` scaffold map (graph.ts), plus a kit `.workflow.js`; native dispatch additionally needs SKILL.md prose. The schema's `topology` enum is the only enforced seam.
- **LSP**: the two agent-binding implementations aren't substitutable (F6).
- **ISP**: the waves payload is one fat object for orchestrator + visualizers (archify-ir reference consumes it too); workable, but the topology_config omission shows consumers weren't enumerated.
- **DIP**: `schemas/graph.schema.ts:2` and `eval.schema.ts:2` import `TIERS` from `targets/types` — schemas reaching upward into the targets layer for a 4-string enum. `compiler→cli` import (F8). Emitter's `templatesDir` injection is fine.
- **Schema↔runtime split**: NodeDef embeds execution policy (`retry`, `timeout_ms`, `effort`, `gate`, `budget_tokens`, `fan_out`, `advisor`, `loop`, `when`) whose semantics live in SKILL.md prose and the orchestrator model, not code; the schema can check only one cross-field rule (advisor⇔loop, `graph.schema.ts:131-139`). This is the real "schema doing too much": it validates tokens for a policy engine that exists only as English.

## Kill-or-keep (re-architecture)

- **DECIDE: one runtime or two.** If the Workflow-tool path is dead, kill `emitter.ts`, `resolver.ts`, `gk graph compile`, and the 8 kit `.workflow.js` templates — they're the only place topology semantics exist; the native path ignores them. If kept, extract topology semantics (routing, refute rounds, tournament rounds) into one definition both runtimes consume; today `topology:` promises behavior the default runtime never delivers (F4).
- **BUILD the IR**: move a `planGraph()` (waves payload incl. `topology_config`) into `compiler/`, unit-tested; waves/agents/ascii/svg become views over it. Kills the CLI-resident planner, the raw-doc re-read (F13), and gives `gk run start` something validated to persist.
- **VALIDATE AT START**: `gk run start` runs schema + pure-semantic validateGraph before creating the ledger; environment checks become non-blocking warnings with `gk init` hints. Cheap fix for the two highest-severity findings.
- **UNIFY errors**: one `formatZodIssues()` → `{path, message, hint?}` in `details`; `GraphKitError` everywhere; delete the `CODE: message` string convention in run.ts.
- **UNIFY agent binding**: `agentFileName` becomes the single rule; node-agents uses it.
- **HOME levelization**: `topoWaves` → `src/graph/` (or compiler/); dedupe loop_contiguous's private wave DFS.
- **RENAME**: CLI `materializeTemplate` → `materializeSessionGraph` to kill the collision.
- **KEEP**: `.strict()` default (correct for agent-authored YAML), Finding severity model, warnings-riding-ok-payload (audit F5), strict/criteria/evidence checks, GraphTemplateSchema (clean, well-refined), exhaustiveness-keyed `TOPOLOGY_TABLE` pattern.
- **OPTIONAL SPLIT**: pull execution-policy fields into `orchestration.schema.ts` only if the re-architecture gives the planner real code to own them; splitting now just moves lines.

Test coverage exists (`tests/unit/compiler.test.ts`, `validate.test.ts`, `template-*.test.ts`, `loop-*.test.ts`) — refactor has a safety net.
