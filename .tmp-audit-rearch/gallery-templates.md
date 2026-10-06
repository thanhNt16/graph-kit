# gallery-templates audit — templates/gallery/{dream,bench-eval,doc-sweep,audit-pr,cook-plan,refactor-module}.gk.yaml

CLI: `gk` 0.3.34 (assignment said 0.3.33 — installed global has drifted one patch). All commands run against materialized scratch copies under /tmp/gk-audit-gallery and /tmp/gk-audit-pi.

## Verdict table

| template | `gk validate` | runnable out-of-box? | required inputs (no default) | agents resolve (fresh `init --target pi`) | `gk graph waves --json` | topology fits purpose? |
|---|---|---|---|---|---|---|
| dream | ok valid:true | **YES** — zero params | none | yes (agents-orchestrator, memory-curator, qa-engineer) | ok — 3 waves, **all parallel:false** | **NO** — labeled `diamond`, actually a linear chain harvest→dream→challenge; shape is adversarial-verification minus adjudicator |
| bench-eval | ok valid:true | **NO** — needs `--params '{"workload":…}'` at materialize AND `--input workload=…` at run start | workload | yes (software-architect, code-reviewer) | ok — 3 waves, wave0 parallel×3 runners | **YES** — only genuine tournament in the gallery |
| doc-sweep | ok valid:true | **NO** — topic required | topic | yes (software-architect, document-generator) | ok — 3 waves sequential; writer carries node-level `loop:` | **PARTIAL** — labeled `loop-until-done` but uses none of its config keys (scouter/worker_batch/stop_rule/dedup/dry_threshold); looping hand-rolled via `node.loop` |
| audit-pr | ok valid:true | **NO** — task required | task | yes (code-reviewer, software-architect) | ok — 3 waves, all parallel:false | **WEAK** — named "pr" but objectives are generic `{{task}}`; nothing PR-specific (no diff/PR input); `diamond` label again on a linear chain |
| cook-plan | ok valid:true | **MECHANICALLY yes — but goal-less** (see F6) | none declared | yes (planner, implementer, test-automator, qa-engineer, release-manager) | ok — 5 waves | **YES** — `custom` is honest; richest contract in gallery (eval-gate role + eval block, loops[].gate_evidence, freshness: strict) |
| refactor-module | ok valid:true | **NO** — module required; notes defaulted | module | yes (software-architect, qa-engineer) | ok — 3 waves; top-level `loops:` on implementer+tester (max_rounds 3, gate_evidence test-results) | **YES** — linear + loop group is the right shape |

**Out-of-box runnable (zero user context): dream only.** cook-plan runs but cannot be told what to do via any declared input. bench-eval, doc-sweep, audit-pr, refactor-module are parameter-gated demos — legitimately so (a benchmark needs a workload), but each one demands its parameter **twice** (materialize `--params` + run `--input`), see F5.

## Findings

**F1 · HIGH — template files are second-class across the graph CLI.** `gk graph waves/ascii/svg/agents/compile/gate` all reject `.gk.yaml` with `SCHEMA_INVALID: expected "Graph"… Unrecognized keys: "parameters","recommendations","graph"` (repro: `gk graph waves templates/gallery/dream.gk.yaml`). Only `validate` has the template pre-check (src/cli/commands/graph.ts:638-644, comment "audit F3"). Error names no remedy — no "this is a GraphTemplate, materialize first". This is the single biggest goal→running-graph cost: **you cannot preview waves/topology of a gallery template without init + materialize first**. A user browsing the gallery must commit writes (`.graphkit/graphs/<id>.yaml`) to see a wave plan.

**F2 · HIGH — fresh-install platform split: default `gk init` ≠ native-dispatch target.** Fresh scratch `gk init` installed to `.claude/agents/` (24 agents). `gk graph agents` then fails `AGENTS_DIR_MISSING`, hinting `gk init --target pi`. Native dispatch (gk-<node-id>.md materialization, src/node-agents.ts:64-66) reads `.omp/agents/` only. An omp-flow user who accepted the default init hits a wall one step before dispatch. All 10 uniquely-bound agents DO ship for every platform (verified `.omp/agents` = 24 files after `--target pi`; bound names all present, zero binding warnings from `gk graph agents` on all 6) — **no template would 404 on agents**, but the *directory* 404s on default installs.

**F3 · MED — `topology:` is decorative in every gallery template.** All six set a named topology, none set `topology_config`; waves derive purely from `depend_on` (dream and audit-pr emit 3 sequential waves under a `diamond` label; `parallel:false` everywhere). Labels promise contracts (`gk graph inspect diamond` advertises fanout.strategy/reduce/synthesizer) that execution never consults here. Two of six labels are actively wrong (dream, audit-pr are chains; the repo's `adversarial-verification` topology matches audit-pr's produce→verify→synthesize intent better).

**F4 · MED — three different loop idioms across six templates.** doc-sweep: `node.loop` (enabled/stop_when/max_rounds, validated src/schemas/graph.schema.ts:32-38, advisory "no stop_when" check src/compiler/validate.ts:67-73). refactor-module + cook-plan: top-level `loops[]` (stop_when XOR gate_evidence, schema :75-85). bench-eval/dream/audit-pr: none. Gallery is the authoring reference; it teaches three syntaxes for one concept.

**F5 · MED — parameters and run inputs are two overlapping input layers; values diverge silently.** Template params are interpolated into objectives **at materialize time** (src/schemas/template.schema.ts:183-204; verified: refactor-module materialized objective permanently reads "Refactor src/store… Notes - Preserve all external contracts…"). SKILL.md (kits/_core/skills/gk-execute/SKILL.md:51) states run `--input` values are provenance-only, "NOT interpolated into node objectives". refactor-module declares `module`+`notes` in **both** layers → materialize with module=src/store, run with `--input module=src/other`, and the dispatched objective still says src/store while ledger provenance says src/other. refact-module's `inputs.notes.default: "{{notes}}"` (refactor-module.gk.yaml:35) is a third copy of the same value.

**F6 · MED — cook-plan has no declared channel for the goal.** No `parameters`, no `inputs`; `gk run start` succeeds with zero input, and `--input goal=…` is rejected against `graph.inputs` ({}). The plan node's objective ("Convert the goal into a phase contract") presumes ambient orchestrator context. Every other template declares its subject (workload/topic/task/module); cook-plan is the only one that can't state its purpose through the artifact. Unusable as a standalone demo; fine only inside the gk-execute conversation flow.

**F7 · LOW — empty-string sentinel defaults produce prompt litter.** Schema forces `optional ⇒ default` (src/schemas/template.schema.ts:113-119); dream complies with `default: ""` → materialized objective literally reads "Focus theme: . Cutoff: ." (verified in materialized YAML). The schema rule pushes authors into sentinel empties rather than conditional omission.

**F8 · LOW — `recommendations.agents` duplicates `nodes[].agent` verbatim.** All six templates restate their node bindings as a flat list (dream: the same 3; bench-eval: the same 2; …). Derivable data, second source of truth that can drift. Same for `recommendations.skills` — doc-coauthoring, receiving-code-review, writing-plans, test-driven-development are referenced but **none ship with the kit** (verified absent post-init; kit ships only gk-* + excalidraw-diagram) — recommendations point users at skills they don't have.

**F9 · LOW — `gk template show` previews counts, not structure.** Output: name/origin/path/description/version/parameterCount/recommendationCount. No node list, no wave plan, no agent bindings. Combined with F1 there is no pre-materialize way to see what a template will do.

**F10 · INFO — agent-binding validation never runs pre-materialize.** `gk validate` on a template short-circuits to GraphTemplateSchema (graph.ts:641) — the `validateGraph` agent-binding/filesystem checks (src/compiler/validate.ts:25-54) only fire on materialized graphs. A template with a typo'd agent passes `gk validate` and fails only later, and binding warnings are advisory, not blocking.

## Friction-log (user steps from "I want to run a gallery template" to dispatching node 0)

Fresh-project path (bench-eval as worst case, best case noted):
1. `gk init` — required before ANY materialize (`GRAPHKIT_NOT_INITIALIZED` otherwise). Default target installs `.claude/agents`, wrong for omp flow → later forced re-step `gk init --target pi` (or start with it).
2. `gk template list` — discover names (gallery resolves from installed package; works uninitialized — good).
3. `gk template show <name>` — counts only; to see topology you must read the YAML from disk (path returned) or materialize.
4. `gk template materialize <name> --params '<json>'` — JSON blob on CLI, no prompt for missing params; missing required → clean `MISSING_PARAMS` naming the key (good error). Writes `.graphkit/graphs/<date>-<name>.yaml`. Does NOT set active pointer unless `--use`.
5. Preview attempt: `gk graph waves <template>.gk.yaml` → SCHEMA_INVALID wall (F1). Must instead: `gk graph waves .graphkit/graphs/<id>.yaml` (typed in full — no tab-completion aid, id embeds date).
6. `gk graph agents <path>` — second AGENTS_DIR_MISSING wall on default installs (F2).
7. `gk run start --graph <path> --input workload=…` — the SAME parameter demanded again (F5); missing → `MISSING_INPUTS` (good error, second layer).
8. Only now: orchestrator reads waves, dispatches `gk-<node-id>` subagents, `gk run node/dispatch/land/end`.

dream (best case): init → materialize (no params) → run start → dispatch = 4 commands, but no wave preview without reading YAML. Minimum friction before first agent runs: **4–8 commands + 2 latent platform walls**, versus the theoretical minimum of 2 (materialize --use + run start).

## SOLID-lens

- **S (naming collision):** `materializeTemplate` exists in both src/commands/template.ts:278 (CLI orchestration) and src/schemas/template.schema.ts:211 (pure substitution, imported as `substituteTemplate`). Same concept, two layers, near-identical names.
- **O (scattered kind-check):** template-vs-graph discrimination is a `doc.kind === "GraphTemplate"` branch in exactly one command (graph.ts:640). Every new graph-consuming subcommand must remember to add the branch; waves/ascii/svg/compile/gate prove the omission mode. A `loadGraphDoc()` that returns a discriminated union would close this.
- **L (labels ≠ behavior):** `topology` accepts any DAG with any label; `diamond` on a linear chain validates and runs. The enum promises execution contracts (inspect config_keys) that nothing enforces — a topology is not substitutable for its documented behavior.
- **I (two input interfaces):** template `parameters` and graph `inputs` are parallel schemas for "user-provided values" with different semantics (bake-time interpolation vs run-time provenance). Consumers (and authors, per F5) can't tell which is authoritative; refactor-module implements both for the same names.
- **D (implicit host-layout dependency):** binding resolution walks a hardcoded 6-path host list with first-hit-wins (validate.ts:26-35); templates depend on agents by bare name with no manifest, and `recommendations.agents` is a hand-maintained duplicate of node bindings rather than a generated/checked contract.

## Kill-or-keep (re-architecture input)

- **Keep as-is:** cook-plan (canonical gk-execute contract: eval-gate, loops[].gate_evidence, freshness:strict — make this the authoring reference), bench-eval (only true fan-out demo), refactor-module (clean loop-group demo — after fixing F5's double declaration).
- **Fix before shipping as "gallery":** audit-pr — rename (it audits a task, not a PR; either add a PR-diff input or call it audit-task) + relabel `adversarial-verification` or honest `custom`. dream — relabel `custom`/chain, replace empty-string defaults with a conditional-omission mechanism (F7), and reconsider `agents-orchestrator` as a read-only leaf harvester (role mismatch; memory-curator or codebase-scout fits).
- **Cut/merge:** doc-sweep's `node.loop` — collapse to one loop idiom (top-level `loops[]`), or promote node.loop to a first-class documented alternative and drop the decorative `loop-until-done` label.
- **Merge recommendation lists into derivation:** generate `recommendations.agents` from `nodes[].agent` (or delete the field); stop recommending skills the kit doesn't ship (or bundle them).
- **Highest-leverage re-architecture moves for init→execute UX:** (1) make waves/ascii/agents template-aware (in-memory materialize with defaults; for required params, preview with `<workload>` placeholders), (2) `gk template materialize --use` as documented default so step 5's path-typing disappears, (3) unify parameters/inputs into one declared-input layer with a single enforcement point, (4) print the `--target pi` requirement in default `gk init` output when the omp flow is detected.
