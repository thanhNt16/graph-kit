# CLI Surface Audit — `gk` 0.3.34 (repo src/ audit-id: cli-surface)

Scope: `gk --help`, all 8 group helps + 6 top-level command helps; `src/index.ts`, `src/cli/app.ts`, `src/cli/command-registry.ts`, `src/cli/output.ts`, `src/cli/graph-inputs.ts`, all 11 files in `src/cli/commands/`, `src/cli/node-agents.ts`, plus a live scratch run in /tmp/gk-audit-scratch (validate → run start → node → evidence → gate → end).

## Command inventory (the 56, verified)

14 top-level (init, new, gate, validate, compile, graph, memory, models, template, inventory, evidence, status, run, suggest) + 42 action-dispatched leaves (graph×15, run×10, memory×5, models×5, template×4, evidence×3) = 56. Matches the "56 command paths" comment at src/index.ts:11.

Classification:
- **User-facing (human authoring/managing)**: init, new, validate, compile, gate, template pack/list/show, models ×5, graph topologies/inspect/new/ascii/svg/list/switch/show, inventory, suggest, memory recall (--explain/--html), evidence report --html. (~24)
- **Agent-plumbing (orchestrator loop)**: run start/node/dispatch/land/end/status/resume/take/round/analyze, graph agents, **graph waves** (dual-purpose: also viz), evidence add/invalidate, memory recall (plain), memory index/touch, gate re-checks, status. (~25)
- **Internal/rarely-invoked**: memory trace (ACT-R decay pass — curator-only), run round (loop-group journal), run analyze, graph index/search/ask/trace/query (thin CBM passthroughs), memory consolidate (end-of-run hook). (~7)

## Findings

### F1 [HIGH] Top-level `gk status` is structurally broken — reads a file nothing writes
- File: src/cli/commands/status.ts:24-32; src/memory/ledger.ts:118-186.
- Evidence: `status.ts` reads `.graphkit/runs/current.json`; grep over src/ shows **zero writers** of `current.json`. Live scratch proof: after `gk run start` succeeded, `gk status --json` → `{"running":true,"run":null,...}` while `gk run status --json` → active run, age, chain. Two "status" commands disagree about the same ledger.
- Worse: kits/claude/skills/gk-run/SKILL.md:20-22 instructs the *agent* to "Keep writing `current.json` as before (the lease-enforce hook reads it)" — the headline status command depends on hand-written agent output. The ledger migrated to `.active` + run dirs; status.ts never migrated.
- Why it hurts: the "orient" command of the product lies (`run:null` during a live run). In a re-architecture this is exhibit A for one source of truth.

### F2 [HIGH] Three commands to go from "run started" to "wave 1 dispatched"
- Files: src/cli/commands/graph.ts:821-986 (waves+agents), run.ts:159-188 (start), node-agents.ts:64-70.
- Evidence: the native dispatch path is `gk run start` → `gk graph waves` → `gk graph agents`. Scratch run: `gk graph agents` fails `AGENTS_DIR_MISSING` with hint "Run `gk init --target pi` first" — a 4th prerequisite. `graph waves` re-validates the graph (3rd validation of the same file after `validate` and start's schema parse) and re-reads raw YAML (graph.ts:838) to preserve `role`/`eval`.
- Why it hurts: this is the exact init→execute friction the re-architecture targets. `run start` could return `{run_id, waves, agents_dir}` in one call; waves/agents are pure functions of the same validated graph + ledger.

### F3 [HIGH] Envelope consistency is ~90%, with 4 documented leaks
- `emit()`/`ok()`/`fail()` (output.ts) is a clean single rule (fail ⇒ exit 1, F6). Violations:
  1. `graph new <topology>` → raw YAML on stdout, `--json` ignored entirely (graph.ts:785). Failure path IS enveloped (UNKNOWN_TOPOLOGY) — so a script can't parse success the same way as failure.
  2. `graph ascii` → raw ASCII art, no `--json` escape (graph.ts:798).
  3. `memory recall --explain --html --json` → prints a bare relative path, envelope skipped (memory.ts:306 returns before the `--json` branch at 313); the --html failure fallback prints bare ASCII too (309, 317).
  4. `evidence report --html` → **silent success**: writes the file, emits nothing, exit 0 (evidence.ts:72-75). An agent cannot learn where the report went without guessing `.graphkit/reports/`.
- Also: `models` uses lowercase code `"map"` (models.ts:62,70) vs SCREAMING_SNAKE everywhere else; `UNKNOWN_MODELS_SUBCOMMAND` doubles for bad target and bad action with `available: <targets>` in both (models.ts:50-56, 80-85) — misleading for the action case. `run end` leaks child git stderr ("fatal: not a git repository") to the console even though the error is caught (observed in scratch; run.ts:37-53 execFileSync).
- Why it hurts: every --json consumer (which is *all* consumers — agents) needs per-command special cases; that's N parsing branches instead of 1 envelope contract.

### F4 [MEDIUM] Two parallel error protocols inside one envelope
- Files: run.ts:55-59 (errCode), graph-inputs.ts:23, run.ts:66,76.
- Evidence: `GraphKitError` (code field) is the typed channel, but run.ts also throws plain `Error("GRAPH_FILE_NOT_FOUND: …")` / `Error("SCHEMA_INVALID: …")` / `BAD_INPUT:` and re-parses the code out of the message with regex `^([A-Z_]+):` (run.ts:57). Three graph loaders with divergent errors: run.ts `parseGraphData`, graph.ts `loadGraph`/`readGraphDoc`, and evidence/gate/status import graph.ts's loader — same failure, different code/message shapes per caller.
- Why it hurts: agents matching on `error.code` get codes only if the string happened to be prefixed; refactor roulette.

### F5 [MEDIUM] Overlapping command clusters (6 distinct redundancies)
1. `init` vs `new` (kit.ts:272-311): `new` = mkdir + init. One function, two commands.
2. `graph new` vs `template materialize` vs `graph switch`: three creation/activation paths for "give me a graph.yaml and make it active". `graph new` prints to stdout and needs the agent to write the file + `graph switch`; materialize writes + `--use`. gk-init-graph/SKILL.md:33 blesses keeping both ("retain existing `gk graph new` behavior").
3. `status` (top) vs `run status` vs `run analyze` vs `suggest`: four orient-surfaces; the top one broken (F1), `suggest` is a status section in waiting.
4. `memory index` vs `graph index`: same verb, opposite stores — memory indexes `.graphkit/memory/` into CBM (memory.ts:36-38), graph indexes the repo (graph.ts:991). An agent cannot infer which from the name; neither cross-references the other.
5. `run take <run-id>` accepts positional (run.ts:307) but its MISSING_ARG message demands `--from <run-id>` (run.ts:309) — two syntaxes for one arg, and the error text contradicts the working one; `--help` documents only `take <run-id>`.
6. `evidence add --node <n>` is declared and documented (evidence.ts:27) but never consumed — `addEvidence` is called without it (evidence.ts:52-57). Dead flag: agents pass provenance that is silently dropped.

### F6 [MEDIUM] `models` group inverts the dispatch grammar
- models.ts:42-93: every other group is `gk <group> <action>`; models is `gk <target> <action>` — 5 leaves × set/reset subactions = 5 command paths for one config file (`.graphkit/models.<target>.json`). `gk models claude set --map …` vs `gk run start` — the second token means "action" everywhere except here, where it means "verb of the first token".

### F7 [LOW] Flag zoo on the `run` group — 19 options shared by 10 leaves
- run.ts:128-148: one cac registration exposes every flag to every leaf (`dispatch` sees `--commit`; `end` sees `--advisor-fired`; `--status` means three different enums depending on leaf). Usage strings are hand-synced prose ("Keep usage in sync with the if-chains" — command-registry.ts:33). Same pattern smaller: memory's `--html/--explain/--origin` are recall-only.
- Why it hurts: no schema-level guard against `gk run end --advisor-fired 3` (silently ignored); help must be read in full to know which flags a leaf accepts.

### F8 [LOW] Fire-and-forget async leaves in `graph`
- graph.ts:988-996, 997-1015, 1016-1030, 1031-1051, 1052-1070: CBM leaves run `(async () => {…})()` inside a sync cac action. Inner try/catch handles emit, but a throw in the synchronous prefix (e.g. seam factory) escapes both the IIFE and the (absent) outer handler → unhandled rejection; also relies on the event loop staying alive past action return.

### F9 [LOW] Two help formats per group
- cac `--help` (Options + Examples from leafUsageFor) vs bare `gk <group>` curated console.log blocks (graph.ts:687-689, memory.ts:235-237, models.ts:45-47, template.ts:412-414, run.ts:153-155, evidence.ts:39-41). Same data, hand-duplicated, already drifting (template's curated block says "--params <json>  Parameters" while cac help says "JSON object of template parameters").

## Friction-log (author → merged, the common path; observed in scratch)

Prerequisites (once): 1. install `gk` binary; 2. `gk init --target <T>` (required earlier than docs imply — `graph agents` hard-fails without `.omp/agents/` + base fragments, node-agents.ts:66-70).

Per graph:
1. `gk graph topologies` / `gk graph inspect <topology>` (or `gk template list` / `gk template show <name>`) — discover; 2 namespaces for the same act.
2. `gk graph new <topology>` → **agent must capture stdout, write the file itself**, then `gk graph switch <id>` (or `gk template materialize <name> --params … --use`).
3. `gk validate graph.yaml --json` (or bare `gk validate` for the active graph — two resolution rules, graph.ts:95-109).
4. `gk run start [--input k=v …] --json` — may fail MISSING_INPUTS (good), RUN_ACTIVE if a previous run never ended.
5. `gk graph waves graph.yaml --json` — third parse of the same file; agent extracts wave plan.
6. `gk graph agents --json` — fails unless init ran with the right target (F2).
7. Per wave, per node: `gk run dispatch <node> --via task --attempt N` → spawn subagent (prompt must embed `run: <id> node: <id> rev: <sha[:12]>` header from start payload) → `gk run node <node> --status ok|fail --wave N --agent A --evidence k1,k2 --duration-ms M`.
8. Worktree mode adds: `gk run land <node> --commit <sha>` + manual git merge/owns-check loop (gk-execute SKILL.md:236-239).
9. Per evidence key: `gk evidence add <file> --key <k> --json` (agent must also know `run node --evidence` records keys on the trace but does NOT stamp the file — two evidence systems).
10. `gk gate --json` → MERGE/BLOCK.
11. `gk run end --status merged|blocked|failed --json`.
12. `gk memory consolidate --json`.

Failure/edge paths add: `gk run status` (NOT `gk status` — broken, F1), `gk run take --from <id>`/`resume <id>`, `gk run round <i>` per loop pass, `gk suggest --dismiss <id>`, `gk memory recall` for curator nodes, `gk models <target> set --map …` for tier overrides. Plus one skill-only secret: hand-write `.graphkit/runs/current.json` or `gk status` stays null (gk-run SKILL.md:20-22).

**Cognitive-load score**: 14 groups / 56 paths exist; the happy path needs **13 distinct command paths across 6 namespaces + ~15 flags + 3 sequencing rules that exist only in skill prose** (waves before dispatch; agents after start + correct init target; evidence files before gate). Roughly 1 in 4 commands is load-bearing for the core loop; the rest is discovery/viz/config surface an agent must still mentally index because help doesn't say which are which.

## SOLID-lens

- **S (SRP)**: `registerGraphCommands` (graph.ts:629-1077) is a 15-way if-chain that also contains the *executor contract* — Kahn sort, curator interleave cadence, per-node payload mapping (904-963) — domain logic living in the CLI layer, with a parallel truth in the compile emitter (`.workflow.js`). graph.ts:111-627 additionally hosts a 500-line template-literal block (YAML strings) inside the command module. run.ts mixes git worktree scanning (orphanedGkArtifacts) into the command handler.
- **O (OCP)**: adding a leaf = touch GROUP_SUBCOMMANDS (command-registry.ts:35-88) + the if-chain + hand-synced usage prose. Help is table-driven, dispatch is not — half-open, half-closed. A leaf-registry (name → handler + usage + flags) would make both ends derive from one table.
- **L (LSP)**: models group violates the group grammar every other group establishes (F6). `graph new`'s non-envelope success violates the output contract its sibling leaves keep.
- **I (ISP)**: 19-flag shared option bag on `run` (F7); every leaf's interface includes every other leaf's flags. cac makes per-leaf interfaces awkward, but the registry proposal solves it.
- **D (DIP)**: cbm-seam.ts is the good case (CBM client injected via seam factories). The bad case: three graph-loading paths with two error protocols (F4) — the CLI layer doesn't depend on one graph-source abstraction, it re-implements loading per file.

## Kill-or-keep (re-architecture proposal: ~10 verbs)

**Proposed surface** (56 paths → 10 verbs, ~20 subactions/flags):

| Verb | Absorbs | Notes |
|---|---|---|
| `gk init [--dir] [--target] [--force]` | init, new | one install/scaffold verb |
| `gk new <topology\|template> [--params J] [--as ID] [--list]` | graph new/inspect/topologies, template materialize/list/show, graph switch | writes session graph + activates; `--list` enumerates templates+topologies with descriptions |
| `gk check [file]` | validate | unchanged semantics |
| `gk run start\|node\|end\|resume` | run start/dispatch/node/land/end/resume/take/round | `start` returns `{run, waves, agents_dir}` **in one call** (kills F2); `node --dispatch/--commit/--round N` absorb dispatch/land/round; `resume --take` absorbs take |
| `gk status [--evidence] [--suggestions]` | status, run status, run analyze, suggest | ONE read surface, `.active`-derived (fixes F1), sections on demand |
| `gk gate [file] [--html]` | gate, evidence report | gate is the report; `--html` writes and returns the path **in the envelope** |
| `gk evidence add\|invalidate [--node]` | evidence add/invalidate | wire or cut the dead `--node` (F5.6) |
| `gk ask <query> [--code\|--memory\|--trace FN]` | memory recall/touch, graph ask/search/trace/query | one retrieval verb; reinforcement + capture-log inside; store chosen by flag not by namespace |
| `gk index [--memory\|--code] [mode]` | memory index, graph index | one indexing verb, two stores, disambiguated by flag (kills F5.4) |
| `gk models [target] [--map k=v] [--reset]` | models ×5 leaves | grammar normalized to `verb --flag` |

Kept as-is: `gk compile` (rare, user-facing Workflow-tool bridge — could later fold into `run start --emit`). Cut outright: `graph ascii/svg` → one `gk draw [file] [--svg]` (11th verb, viz-only, loses its role as execution contract); `graph show` (read the file); `memory trace/touch` (automatic side-effects, not user verbs); `current.json` (delete the ghost — F1).

**Kill list highlights**: 5 models leaves; `run dispatch`/`land`/`take`/`round` as separate paths; `suggest` and `run analyze` as commands; `graph new`-to-stdout; `evidence report` as a separate command; dual index/recall namespaces.

**Net effect on the common path**: 13 invocations → ~7 (`init` once, `new`, `check`, `run start`, N×`run node`, `evidence add`×K, `gate`, `run end`) spanning 5 namespaces instead of 6, with zero skill-only secrets if `run start` owns waves+agents and `status` owns orientation.
