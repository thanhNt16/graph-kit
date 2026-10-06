# Audit: gk-validate + gk-visualize skills, graph.ts (validate/waves/agents)

Scope: `kits/_core/skills/gk-validate/SKILL.md`, `kits/_core/skills/gk-visualize/SKILL.md` (+ `references/archify-ir.md`, `graph-palette.md`), `src/cli/commands/graph.ts`, `src/compiler/validate.ts`, `src/cli/node-agents.ts`, `src/cli/output.ts`, `src/schemas/graph.schema.ts`. Every documented flow executed on `.tmp-e2e/graph.yaml` + 2 broken variants (semantic, schema) in `.tmp-audit-rearch/scratch-skill-validate-visualize/`. Installed CLI tested: gk 0.3.34 (context said 0.3.33).

## Findings

### F1 — HIGH — validate gate and agents-verb gate disagree; green validate → red dispatch-prep
- Files: `src/compiler/validate.ts:26-48` vs `src/cli/node-agents.ts:64-70`
- Evidence: in a fresh project (no agent dir), `gk validate graph.yaml --json` → `{"status":"ok","data":{"valid":true,...}}` exit 0 (agent-binding check silently skipped: `if (agentDir && !available.includes(expected))`). The next step in the native-dispatch contract, `gk graph agents graph.yaml --json`, fails: `AGENTS_DIR_MISSING "No .omp/agents directory …" hint: Run gk init --target pi first` exit 1. Second divergence: validate accepts agents in any of 6 dirs (`.omp/agents`, `.claude/agents`, `.cursor/agents`, `.opencode/agent`, `.codex/agents`, `claude/agents`); the materializer reads only `.omp/agents`. A graph validating green against `.claude/agents` still dies at `gk graph agents`.
- Why it hurts: this is exactly the complained-about init→execute wall. The one command that is supposed to be the gate ("Ready for execute") certifies a state the very next command rejects. Agent burns a round-trip and must interpret a second error taxonomy (AGENTS_DIR_MISSING/AGENT_NOT_FOUND) the skill never mentions.

### F2 — HIGH — two failure envelopes + masked cross-checks force N+1 validate round-trips
- Files: `src/cli/commands/graph.ts:653,648`; `src/schemas/graph.schema.ts:225-303`; skill `gk-validate/SKILL.md:24-35`
- Evidence: schema failures → `{code:"SCHEMA_INVALID", details:{issues:[{path,message}]}}`; semantic failures → `{code:"VALIDATION_FAILED", details:{findings:[{check,path,message,severity?}]}}`. The skill documents ONLY the findings shape and its failure examples include `cycle` — but a cycle never arrives as a finding; it arrives as a schema issue (`"depend_on forms a cycle"`, path `nodes.a.depend_on`). Worse: Zod runs `superRefine` (cycle, fan_out reachability, node-id charset) only after the base strict parse succeeds. Graph with unknown key `limits` + `loop.exit_condition` + cycle a↔b + bad `fan_out.briefs_from` reported ONLY the 2 unknown keys (measured). Removing the unknown keys surfaced 2 more issues (cycle + fan_out) on a second run. Each layer of repair requires another round-trip.
- Why it hurts: the skill's promise "rejected at parse time" is true per-layer but the agent experiences a peel-the-onion loop: fix typo → revalidate → find cycle → fix → revalidate → semantic findings. For an agent looping on `error.details.findings` per the skill, `issues` are invisible → it reports "unknown error" or hallucinates.

### F3 — MED — gk-visualize SKILL.md names a command that does not exist
- Files: `kits/_core/skills/gk-visualize/SKILL.md:15-17,67,76,84`; `src/cli/commands/graph.ts` (no visualize verb)
- Evidence: skill says "Explicit `visualize --ascii` mode", "Explicit `visualize --svg` mode", "Explicit `visualize --excalidraw`". Actual surface: `gk graph ascii|svg` subcommands. `gk visualize graph.yaml --ascii` → `Unknown command: visualize` + full help dump, exit 1 (measured). There is no excalidraw verb at all — that mode is pure agent-side work via the excalidraw-diagram skill.
- Why it hurts: an agent that follows the mode syntax verbatim dies mid-flow and must recover by guessing the real verb from `gk --help`. Cheap fix: doc should say `gk graph ascii` / `gk graph svg`.

### F4 — MED — skill's PASS contract quotes payload text that doesn't exist; "fails fast" is wrong in both directions
- Files: `kits/_core/skills/gk-validate/SKILL.md:10,26`; `src/cli/commands/graph.ts:645-651`
- Evidence: skill: PASS (`status:"ok"`): "Graph validated successfully. Ready for execute." Actual ok payload: `{valid:true, topology:"diamond", warnings:[]}` — no message field anywhere (measured, T1/T2). Also "Fails fast on first error": the schema pass collects ALL issues it can before refinements mask further layers, and the semantic pass deliberately collects all findings and reports them together — it is the opposite of first-error exit. An agent string-matching the quoted sentence finds nothing; an agent expecting one-finding-per-run mis-batches its fixes.
- Why it hurts: contract-by-prose instead of contract-by-shape. Agents should key on `status` + `valid` + error `code`; the doc actively teaches the wrong keys.

### F5 — LOW — gk-visualize doc drift on ASCII/SVG specifics
- Files: `kits/_core/skills/gk-visualize/SKILL.md:72,80,82`; `src/cli/ascii.ts` (renderer), `src/cli/commands/graph.ts:802-820`
- Evidence: skill claims emoji tier icons "🟣opus 🔵sonnet 🟢haiku" and loop indicator "↻"; actual ASCII uses text legend `[O]=opus [S]=sonnet [H]=haiku [F]=fable` and the literal suffix `loop` on the node box (measured, T13/T31). Skill claims SVG "opens in browser" — `gk graph svg` writes `.graphkit/diagrams/{name}.svg` and emits `{svg: <path>}`; nothing opens (measured, T15; code confirms no open call). "Renders at 1.2ms" — full CLI wall time 81ms (T25); the 1.2ms figure is unverifiable marketing.
- Why it hurts: minor alone, but three wrong specifics in one skill teach the agent to distrust it; the SVG claim can cause an agent to wait for a browser that never opens or try to open one itself against the "do not auto-open" rule the same doc sets for archify.

### F6 — LOW — envelope heterogeneity: same verb, two ok shapes; ascii is raw-on-success/JSON-on-failure
- Files: `src/cli/commands/graph.ts:81-94` (template ok), `:786-801` (ascii); `src/cli/output.ts:3` ("The JSON envelope every gk command emits")
- Evidence: `gk validate tmpl.yaml` (kind: GraphTemplate) → ok `{valid:true, kind:"template", name, parameters}` (T21b) vs graph validate → `{valid:true, topology, warnings}` (T1). `gk graph ascii` success = raw boxed ASCII on stdout, failure = JSON fail envelope (T13/T14). `gk graph new` also raw. The `--json` options on validate/compile/graph are decorative — output format is invariant; the flag suggests a text mode that doesn't exist.
- Why it hurts: agents must branch on exit code + format instead of parsing one shape; the LSP violation of the envelope contract is the kind of thing that bites a re-architecture that assumes "one envelope" is true.

### F7 — LOW — waves payload quirks: curator double-counted; two normalization regimes in one node object
- Files: `src/cli/commands/graph.ts:833-852,904-929,940-951`
- Evidence: memory-augmented waves (T23): `total_nodes: 4` counts the curator, but action waves exclude it and curator waves repeat it (5 waves: 3 action + 2 curator entries). A consumer summing `waves[].nodes` gets 5 ≠ `total_nodes` 4 ≠ 3 unique. Also: `role`/`eval` are read back from raw source YAML (`readGraphDoc` re-parse, graph.ts:838-839) while every sibling field is schema-normalized with defaults — `model` is defaulted to `"sonnet"` but `role` may be absent/null; `hooks` array object repeated identically per node.
- Why it hurts: diagram/IR builders (the documented consumer of waves) must special-case the curator and two field regimes; any future consumer computing progress from node counts will be wrong.

### F8 — INFO — findings carry no machine-actionable fix data; skill's fix table covers 4 of 22 check names
- Files: `src/compiler/validate.ts:7-15` (Finding = {check, path, message, severity?}); `kits/_core/skills/gk-validate/SKILL.md:29-35`
- Evidence: no `actionable`, `fix`, or `hint` field on findings (contrast: GraphKitError details carry `hint` — AGENTS_DIR_MISSING does). 22 distinct check names exist in validate.ts (zero-nodes, agent-binding, refs-exist, loop-exit, evidence-key-path, evidence-keys, duplicate-required-key, duplicate-evidence-producer, criteria-keys, criteria-file, memory-inner, memory-curator-node, eval-gate-config, eval-gate-depend_on, unknown-role, owns-overlap, constraint-source, constraint-value, loop_node_exists, loop_no_overlap, loop_gate_evidence_declared, loop_contiguous). The skill maps plain-language fixes for exactly 4 (agent-binding, refs-exist, cycle — which is misnamed, loop-exit). Example messages also drift: skill "Ref path 'docs/foo.md' doesn't exist. Create it or remove the ref." vs actual `Ref "docs/does-not-exist.md" does not exist` (no suggestion). Also undocumented: `refs[]` entries REQUIRE `purpose` (RefSchema strict) — agents hit an unrecognized-key issue for omitting it.
- Why it hurts: fix knowledge lives in prose, half of it absent. The severity model is also binary with an inversion trap: `severity` absent ⇒ BLOCKING, `"warn"` ⇒ advisory (`isBlocking = f.severity !== "warn"`) — one typo of `"warning"` silently blocks.

### F9 — INFO — version/context drift (no behavioral divergence found)
- Installed gk is 0.3.34, context said 0.3.33; repo package.json says 0.3.0 (dev). All tested behavior matched src@HEAD for my surface.

### F10 — INFO — cross-verb addressing inconsistency (graph verbs vs run verb)
- `gk run start` takes `--graph <path>`; `gk graph agents|waves|ascii|svg` take a positional file arg; bare `gk validate` resolves active-session pointer → root graph.yaml. Three addressing conventions in one flow (verified via --help surfaces + T17-T20). The bare-validate resolution paths (NO_ACTIVE_GRAPH, INVALID_SESSION_ID on malformed `.graphkit/active` content, ACTIVE_POINTER_DANGLING) are undocumented in the skill entirely.

## Friction-log (every step an agent performs in this surface, goal → running graph)

Happy path, measured:
1. Author graph.yaml (no skill guidance on scaffolding here; `gk graph new <topology>` prints a template to stdout — raw, not envelope).
2. `gk validate graph.yaml --json` — PASS requires: schema-strict keys (incl. refs[].purpose), no cycle/fan_out violation (masked until unknown keys fixed — see F2), semantic findings clean. NOTE: PASS does NOT mean agents dir exists (F1) and does NOT mean dispatch will succeed.
3. If schema-broken: parse `error.details.issues`; if semantic-broken: parse `error.details.findings` (two shapes, F2). N+1 round-trips when both classes present (measured: 2 passes minimum).
4. `gk graph agents graph.yaml --json` — re-validates (2nd full validateGraph pass); requires `.omp/agents` present (else AGENTS_DIR_MISSING + hint `gk init --target pi`); writes `.omp/agents/gk-<node>.md` per node, prunes stale `gk-*`; returns `{agents:{node→gk-node}, dir, warnings}`.
5. `gk graph waves graph.yaml --json` — re-validates (3rd pass); returns wave plan (curator interleaved for memory-augmented), evidence_required, on_graph_complete, warnings.
6. Then (outside my surface) `task` subagents per node via `gk-<node>` agents, `gk run node|dispatch|land|end`.
Visualize (optional, default mode): bash probe for archify → `archify doctor` → `gk graph waves` (4th validateGraph pass if run here) → read `references/archify-ir.md` → author IR at `.graphkit/diagrams/{name}.archify.json` → `archify validate <type> … --quality showcase --json` (≤5 cycles) → `archify deliver …`. All steps verified working on the shipped worked example (9/9 checks, 700KB HTML delivered).

Round-trip count for a healthy-but-uninitialized project: validate(PASS) → agents(FAIL AGENTS_DIR_MISSING) → gk init → agents(OK) → waves(OK) = 5 CLI invocations where 2 should do (init check + plan).

## SOLID-lens

- **SRP violation (worst offender):** `registerGraphCommands` (graph.ts:629-1077) is a ~450-line if/else chain embedding executor-domain logic — the memory-augmented curator interleave planner (graph.ts:846-898) duplicates `memory-augmented.workflow.js` wrappedAgent semantics (per its own comment at graph.ts:843-845). Two interleave implementations WILL drift; the comment even admits the CLI one is the "execute-path equivalent".
- **OCP:** new graph subcommand = edit the else-if chain AND `command-registry.ts` GROUP_SUBCOMMANDS. Two-place edit for one verb.
- **LSP/contract:** "The JSON envelope every gk command emits" (output.ts:3) is false for `graph ascii`/`graph new` success paths (F6) — a re-architecture that trusts the comment breaks.
- **ISP:** waves node objects carry 20+ fields incl. full objective strings and a repeated `hooks` array (graph.ts:904-928) when the documented consumer (archify IR) needs 7 (`agent, model, objective, tools, depend_on, loop, evidence` — the skill's own list). Fat payload = every diagram consumer re-implements field selection.
- **DIP/two-sources-of-truth:** "agent directory" resolved by validateGraph (6-dir probe, validate.ts:26-35) vs hardcoded `.omp/agents` in materializeNodeAgents (node-agents.ts:65) — F1 is a DIP failure manifesting as a UX wall. The archify dependency, by contrast, is properly inverted (probe → ask → fallback SVG) and works end-to-end.
- **Positive:** `topoWaves` shared by executor and both renderers (graph-waves.ts) is the right seam — renderers cannot disagree with the executor. Keep that pattern; extend it to agent-dir resolution.

## Kill-or-keep (re-architecture guidance)

- **Keep:** single `Result` envelope + F6 exit-code rule (output.ts); findings `{check,path,message,severity}` primitives; strict schema (parse-time posture is good); `topoWaves` shared levelization; archify probe→fallback flow (verified E2E); bare-`validate` active-pointer concept (but document it).
- **Fix:** one agent-dir resolver shared by validateGraph + materializeNodeAgents (kills F1); run graph cross-checks tolerant of unknown keys (collect unknown-key issues without skipping superRefine — kills the masking in F2); rewrite both skills' command syntax to the real surface (`gk graph ascii|svg`, no `gk visualize`) and contract-by-shape not contract-by-prose (kills F3/F4/F5); add `hint`/`fix` to findings and cover all 22 check names (F8).
- **Merge:** validate + waves + agents into one `gk graph plan <file> --json` returning `{valid, findings, waves, agents:{mapping,dir_ready}}`. Collapses 3 invocations + 3 redundant validateGraph passes into 1 round-trip, makes the F1 divergence structurally impossible, and directly attacks the init→execute friction. `gk validate` survives as the thin read-only form of the same pipeline.
- **Cut:** decorative `--json` flags (or honor them as a text mode); per-node repeated `hooks` in waves payload (hoist once); curator double-count (`total_nodes` should count unique action nodes or waves should reference, not repeat, the curator); doc claims like "1.2ms" and emoji icons that don't match output.

Scratch evidence preserved in `.tmp-audit-rearch/scratch-skill-validate-visualize/` (broken variants, materialized agents, delivered archify HTML).
