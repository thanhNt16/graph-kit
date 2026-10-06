# Audit: gk-init-graph + gk-template skills, template CLI, template schema

Scope: `kits/_core/skills/gk-init-graph/SKILL.md`, `kits/_core/skills/gk-template/SKILL.md`, `src/cli/commands/template.ts`, `src/schemas/template.schema.ts`. Installed CLI tested: **gk/0.3.34** (contract said 0.3.33; repo package.json says 0.3.0 — version provenance is someone else's surface). All 6 gallery templates instantiated in `.tmp-audit-rearch/scratch-SkillInitTemplate/`; pack/materialize/list/show error paths exercised.

## Findings

### F1 — CRITICAL · gk-template SKILL.md:52-57 · step-8 commands defeat steps 2–7
`templateFromSource` (template.ts:79-110) hardcodes `parameters: {}` and empty recommendations. All parameter/recommendation work must ship via a prepared file + `--input` (template.ts:113-123, 162). But the skill's step 8 examples are `gk template pack graph.yaml --name <name>` — no `--input`. An agent following them literally gets `status: ok`, `parameterCount: 0`, and silently loses every decision from steps 2–7. Verified: `pack plain.yaml --name my-diamond` → `parameterCount:0, recommendationCount:0`. The prose ("Write the prepared input to a temporary GraphTemplate file") and the commands contradict each other; the flag that carries the whole feature is named nowhere in the skill.

### F2 — CRITICAL · init-graph SKILL.md (whole flow) · `gk init` is an undocumented prerequisite
`materialize` fails in any project without `.graphkit/`: verified `GRAPHKIT_NOT_INITIALIZED: No .graphkit/ directory — run 'gk init' first` — thrown by `saveSessionGraph` at the *last* step of the 7-step skill flow (template.ts:328 → store). Meanwhile `template pack` works fine without init (atomicWrite mkdirs, template.ts:126-145) — inconsistent stores. The skill's Purpose even describes writing to `.graphkit/graphs/` but never says the dir must exist. This is the exact "init→execute friction" the re-architecture targets: a fresh project dies on step 6 of 7 with an error the skill never prepared the agent for.

### F3 — HIGH · `template show` cannot serve its only consumer · template.ts:337-369
`runTemplateShow` returns `parameterCount`/`recommendationCount` only — no parameter names, required flags, defaults, descriptions, no recommendation lists. init-graph step 3 ("Ask one focused question for each unresolved required parameter") and step 4 (compare "template recommendations" against inventory) are impossible from `show` output. Verified: `show audit-pr` → counts only. The workaround — `read` the raw `.gk.yaml` at the absolute path `show` happens to return (for gallery: inside the global npm install) — is documented nowhere. Verified `materialize` fails helpfully on missing params (`MISSING_PARAMS {missing:["task"]}`) but by then the agent has already guessed.

### F4 — HIGH · template params vs graph inputs are disconnected systems → task entered twice
Materialize substitutes `{{task}}` into objectives (verified correct in `2026-10-06-audit-pr.yaml`), but the gallery graphs keep `inputs.task.required: true`. `gk run start` on the materialized graph fails: verified `MISSING_INPUTS: required input(s) have no default and no --input value: task`. The value the user gave at init must be re-supplied at execute. Root cause is architectural (see SOLID): `GraphTemplate.parameters` and `Graph.inputs` are two unlinked parameterization namespaces; the param contract (template.schema.ts:106-119) even *forbids* required-param defaults, so a template author cannot bridge them. Neither skill mentions the run-time re-entry. This is the single biggest hidden tax on init→execute.

### F5 — HIGH · skill claims "one command writes the file and sets it active" but `--use` is optional · init-graph SKILL.md:57-59 vs template.ts:330-333
Without `--use`, `setActiveGraphId` is not called. Verified: materialized `doc-sweep` without `--use` → `.graphkit/active` still pointed at `audit-pr-2`. An agent that follows the prose and omits the bracketed flag silently leaves the wrong graph active; the subsequent `gk run start` runs the *previous* graph. Confusing-state failure mode, no error, wrong-graph execution risk.

### F6 — HIGH · one corrupt template poisons the entire template surface · template.ts:218-219
`runTemplateList` calls `readTemplate(path)` (throws GraphKitError) for every store entry with no per-item tolerance. Proven live: after planting one template with a stray `{{topic}}`, `gk template materialize diamond` (any unknown-name path calls list for suggestions, template.ts:295) failed with `TEMPLATE_INVALID … has-placeholder.gk.yaml` instead of "Unknown template diamond". `list` and `show` suggestions die the same way. A user hand-editing one template in `~/.graphkit/templates/` breaks every template command with an error naming the wrong command target.

### F7 — MEDIUM · pack accepts never-materializable templates · template.ts:79-110
`templateFromSource` builds the GraphTemplate object literal directly and never runs it through `GraphTemplateSchema` (the `.superRefine` at template.schema.ts:94-165). A source graph containing literal `{{foo}}` text packs OK (verified: `pack placeholder.yaml --name has-placeholder` → ok) and then fails at materialize time (`TEMPLATE_INVALID: Placeholder "{{topic}}" references undeclared parameter`). Late failure exactly where the pipeline can least afford it; one `safeParse` of the constructed template at pack time would move the error to creation.

### F8 — MEDIUM · init-graph SKILL.md:14-17 implies an `init-graph` CLI that doesn't exist
Invocation block is fenced like a command (`init-graph [--template <name>] [--task …]`); `gk init-graph` → verified `Unknown command: init-graph`. The skill is really a multi-command choreography (template/graph/inventory/suggest/validate), but nothing in the doc says the name is not a binary. Agents will burn a step discovering this.

### F9 — MEDIUM · pack with `--input` requires a positional file it then ignores · template.ts:417-426, 162
`pack` demands `argAt(0)` (`MISSING_FILE`) before checking `--input`; with `--input` present the positional is never read. Verified: `pack --input X --name Y` → MISSING_FILE; `pack junk.yaml --input X --name Y` → ok, junk.yaml unread. The documented-in-registry usage `<file> --name <name> [--input <file>]` makes the dummy-arg dance look intended. Also: with `--input`, the written file is keyed by `--name` but internal `metadata.name` is whatever the input says — verified silent mismatch (`renamed-copy.gk.yaml` containing `metadata.name: my-diamond`).

### F10 — LOW · doc drift inside/around the skills
- init-graph:34 lists 4 gallery candidates (`audit-pr, refactor-module, bench-eval, doc-sweep`) — gallery now has 6 (`cook-plan`, `dream` unlisted). Hand-maintained duplication of `templates/gallery/`.
- gk-template:62: parameter `description` "required, non-empty" — schema says optional (`template.schema.ts:23`, comment even says "recommended but not required"). Verified pack succeeds without description.
- init-graph:62: "same-day collisions append -2, -3" is `saveSessionGraph` behavior for the packaged path only; on the canonical path the *agent* must implement naming/collision by hand (`gk graph new` prints YAML to stdout, nothing else).
- init-graph:38 vs :40: step 2 says "for the active target" then hardcodes `--target pi`. Build-time substitution rewrites this per kit (installed claude kit says `--target claude` — verified in package + project install), but the `_core` source relies on raw-token replacement (`pi`, `Cursor` → product name) with no placeholder syntax marking them as substitutable.
- Installed gk is 0.3.34 while contract/repo say 0.3.33/0.3.0.

### F11 — LOW · substitution leaves empty-default prose artifacts
`dream` (optional params defaulting to `""`) materializes objectives reading "Focus theme: . Cutoff: ." (verified). Embedded-optional-substitution has no conditional-text story; cosmetic but lands in agent-facing objectives.

### F12 — LOW · no cross-namespace error hint
`gk template materialize diamond` → `TEMPLATE_NOT_FOUND`, closeMatches `["my-diamond"]`, but no hint that `diamond` is a canonical topology reachable via `gk graph new diamond` (topology names are knowable at this point). init-graph:33 documents the dual meaning of `--template`; the CLI doesn't.

### F13 — LOW · `shadowed` flag semantics wrong/incomplete · template.ts:225-230
project→checks global only (ignores gallery); global→hardcoded `false` (but global shadows gallery); gallery→checks global+local (correct). Verified structure by read; consequence is cosmetic (misleading `list` metadata).

### F14 — INFO · inline `require("node:fs")` in an ESM tree · template.ts:137, 373
Works only because bun's bundle injects `createRequire`; running from source under plain node ESM, `readDir` would crash. Also `unlinkSync`/`readdirSync` should be top-level imports like their siblings.

## Friction-log (agent steps on the documented init→execute path)

Packaged-template path (the happy path init-graph advertises):
1. `gk init` — *undocumented; discovered via late failure* (F2)
2. `gk template list --json` — pick candidate (skill also wants `gk suggest --json`)
3. `gk template show <name> --json` — returns counts only; *insufficient*
4. `read <abs-path-from-show>` raw gallery `.gk.yaml` (inside global npm install) — *undocumented hop* to learn params/recommendations (F3)
5. `gk inventory --json` — gap analysis (note: must know to drop the doc's `--target` literal)
6. user round-trip: params + model changes approval (skill gate)
7. `gk template materialize <name> --params '<json>' --use --json` — must remember `--use` (F5)
8. `gk validate <session-path> --json`
9. → execute: `gk run start … --input task=…` — **task re-entry** (F4)

Canonical-topology path adds: `gk graph new <topology>` (stdout only) → agent hand-writes `.graphkit/graphs/<date>-<slug>.yaml` with manual collision suffixes → `gk graph switch <id>` → validate. ~4 more steps, all agent-implemented.

Packaging path (gk-template): `gk validate graph.yaml --json` → read graph, infer params by hand (no tooling) → `gk inventory --json` → show proposal → user gate → hand-author full prepared `.gk.yaml` → `gk template pack <dummy-file> --input <prepared> --name <name>` (F9) → *silent zero-param trap if the documented command is used instead* (F1).

Net: 7–9 CLI calls + 1 raw file read + 1–2 user round-trips + 1 duplicate value entry before a run can start; hard failure points at steps 1, 7, 9.

## SOLID-lens

- **SRP**: template.ts is cohesive-ish, but `materializeTemplate` (template.ts:278-335) spans name validation, store resolution, param checking, substitution, graph validation, session persistence, activation — 7 concerns in one function; the two same-named `materializeTemplate` exports (schema substitution vs CLI orchestration, the CLI importing the schema one as `substituteTemplate`) invite exactly the confusion that produced F1's doc/CLI split.
- **OCP**: subcommand dispatch is an if-chain (template.ts:410-489, mirroring graph.ts); adding a subcommand touches dispatch, `command-registry.ts`, *and* the hand-written bare-usage options block (template.ts:412-414 duplicates what the registry could derive). Three edit sites, drift-prone.
- **LSP/priority-policy duplication**: `resolveTemplate` walks project→global→gallery (template.ts:57-65) while `runTemplateList` walks gallery→global→project relying on map overwrite for the same precedence — two hand-rolled inverse implementations of one policy; `shadowed` (F13) already drifted from both.
- **ISP**: `template show` is the machine interface init-graph depends on; it exposes counts where its consumer needs definitions (F3). Interface designed for humans summarizing, not for the agent flow it exists to serve.
- **DIP/layering**: the root architectural issue — template layer (`GraphTemplate.parameters`, string substitution) and graph/run layer (`Graph.inputs`, run-time required inputs) never touch; materialize hands an unvalidated-against-inputs graph to the session store. Gallery authors bridge them by *naming discipline only* (duplicate `task` in both namespaces). The re-architecture should make materialize either consume inputs or generate them (e.g. params of matching name seed `inputs.<name>.default`).
- **Fragile build-time contract**: `_core` skills depend on raw-token substitution (`pi`, `Cursor`) by the packager with zero placeholder marking; gallery names and topology routing tables are copy-pasted into prose from data that has a runtime CLI (`gk graph topologies` already exists — the skill both points to it and inlines its own copy). Topology names now live in 5 places: schema enum (schemas/topology/index.ts), emitter map (compiler/emitter.ts:14-19), `graph new` stubs (cli/commands/graph.ts:245-284), topologies registry output, and the SKILL.md routing table.

## Kill-or-keep (re-architecture)

**Cut**
- The hand-written bare-`gk template` usage block — derive from command-registry.
- The dummy positional for `--input` packs — make `pack --input` standalone.
- `_core` token substitution (`pi`/`Cursor`) → real placeholders or per-target source files.
- Inline copies of topology routing/node-field reference in SKILL.md — the CLI already serves this (`gk graph topologies/inspect`); keep at most a Tier-3 pointer.
- `require("node:fs")` indirections.

**Merge**
- The two creation paths behind one materialization entry: `gk template materialize --from-topology diamond` (or `gk graph new --save --use`) so the canonical path stops being 3 agent-implemented steps; collision/naming moves back into tooling.
- The parameter contract into a shared Tier-3 `references/` file consumed by both skills (init-graph's agent currently has no access to the contract it must obey at materialize).
- `show` and `materialize` param discovery: `show` should return full `parameters` + `recommendations`; MISSING_PARAMS should carry descriptions/defaults.

**Keep**
- Atomic write + temp cleanup (template.ts:126-145), `closeMatches` suggestions, MISSING_PARAMS-before-write ordering, session immutability + `-2` collision naming, project>global>gallery ladder (as one implementation, not two).
- Strict param contract refinements (unused/undeclared/required+default) — they're good, just run them at pack time too (F7).

**Fix-first if only three things**: `gk init` auto-bootstrap (or skill mentions it) (F2); `show` returns parameter definitions (F3); materialize seeds graph inputs from same-named params (F4). Those three remove the late failures, the blind parameter collection, and the double entry — the entire measurable tax on init→execute.
