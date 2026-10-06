# UX Journey Audit — graph init → graph execute (ux-journey)

Method: followed `kits/_core/skills/gk-init-graph/SKILL.md` literally (102 lines) in a fresh dir, then re-ran the same flow guided ONLY by `kits/_core/skills/gk-execute/SKILL.md` (380 lines). Task: "audit PR #42 for security issues" → routed to gallery template `audit-pr` (3-node diamond). Every command timed. Installed CLI: gk 0.3.34 (context said 0.3.33).

## Findings

**F1 [HIGH] — Graph identity is triple and inconsistent per command.**
Evidence: `gk template materialize --use` returns `id: 2026-10-06-audit-pr`; `gk run start --graph 2026-10-06-audit-pr` → `GRAPH_NOT_FOUND`. `src/cli/commands/run.ts:96` (`if (flag) return flag;`) — explicit `--graph` is treated as a path verbatim, never resolving session-graph ids; id resolution exists only in `gk graph show` (`src/cli/commands/graph.ts:751-755`) and `src/store/index.ts:81`. Active-pointer fallback exists but ONLY when `--graph` is omitted (`run.ts:97-99`). Meanwhile `gk graph agents` has NO active fallback: `src/cli/commands/graph.ts:973` (`file ?? join(process.cwd(), "graph.yaml")`).
Why it hurts: the very first thing the materialize payload hands the user (the id) is rejected by the next command in the documented flow. Three resolution rules across sibling commands = every command is a guess.

**F2 [HIGH] — Two undocumented init prerequisites split by target.**
Evidence: `gk template materialize` → `GRAPHKIT_NOT_INITIALIZED` (`src/store/index.ts:14-15`); then `gk graph agents <path>` → `AGENTS_DIR_MISSING` (`src/cli/node-agents.ts:66-69`). Plain `gk init` (no target) creates `.graphkit/` but NOT `.omp/agents`; a second `gk init --target pi` is required. Neither SKILL.md names these as prerequisites at the point of need — gk-execute mentions `gk init --target` only as a kitVersion-mismatch refresh (SKILL.md:49); gk-init-graph runs `gk inventory --target pi` (SKILL.md:40) but never tells you to init.
Why it hurts: 2 of 8 literal-path failures are the same root cause the docs never state.

**F3 [HIGH] — Skill protocol split-brain.**
Evidence: gk-init-graph writes session graphs to `.graphkit/graphs/<date>-<slug>.yaml` + `.graphkit/active` (SKILL.md:12, 62-65); gk-execute assumes `./graph.yaml` (`gk graph waves graph.yaml`, SKILL.md:35; `gk run start --graph graph.yaml`, SKILL.md:43). Literal flow-2 step 1 fails on a graph created by the init skill. Conversely, gk-execute's protocol (dispatch intents, `--wave`, evidence stamping, gate, consolidate — SKILL.md:96-167, 367-378) is invisible to the init-graph reader.
Why it hurts: the 380-line execute skill is the de-facto orchestration spec, but nothing links init's output to execute's input contract. The "compiler" is an LLM reading two documents that disagree.

**F4 [MED] — `gk run end` doesn't enforce the graph's own contract.**
Evidence: flow 1 ended `merged` with 1/3 nodes recorded and required evidence key `audit-report` absent; exit 0. gk-execute:378 says "Only MERGE with exit 0 permits completion" — but the gate is invoked by the agent, never by `end`.
Why it hurts: a lazy or drifted agent ships an empty run marked merged; the ledger then lies to `memory consolidate` and `resume`.

**F5 [MED] — Three names per node.**
Evidence: node id `reviewer`, graph field `agent: code-reviewer`, materialized agent `gk-reviewer` (only discoverable from `gk graph agents` output). Dispatch (`agent: gk-<node-id>`, gk-execute:100) needs one, recording (`--agent`) another.
Why it hurts: pure threading overhead; nothing validates that the agent you recorded matches the materialized one.

**F6 [MED] — Evidence ceremony is 2N steps plus a conventioned path.**
Evidence: write `<evidence_dir>/<key>.md` (path convention from graph outputs, gk-execute:369) + `gk evidence add <file> --key <k> --node <n>` per key (rewrites the file with fingerprint frontmatter, copies to artifacts — verified: 20-byte file became 482 bytes with marker). Markerless file = BLOCK under strict freshness (gk-execute:380).
Why it hurts: 3-node diamond → 6 steps; the failure mode (hand-written evidence) is prose-enforced only.

**F7 [LOW] — `gk template show` returns metadata only** (name/origin/paramCount/recommendationCount) — an agent cannot preview node substitutions without materializing. Conflicts with the skill's "review changes" step (init-graph SKILL.md:54).

**F8 [LOW] — Flag-dump help.** `gk run --help` prints all 17 options for every subcommand (`src/cli/commands/run.ts:127-148`); real grammar lives only in one `.example` line.

**F9 [LOW] — Misleading recovery hints.** `GRAPH_FILE_NOT_FOUND` hint suggests `gk graph new` even when a session graph is active; the run-start failure for a session id gives no hint at all.

**F10 [INFO] — Latency is not the problem.** Every CLI call < 0.25s; total CLI time across both flows < 5s. All friction is procedural: steps, flags, context state, and failure recovery.

## Friction-log

### Flow 1 — guided ONLY by gk-init-graph/SKILL.md (fresh dir)
| # | command | result | wall |
|---|---------|--------|------|
| 1 | `gk template list` | ok | 0.10s |
| 2 | `gk suggest --json` | ok (0 suggestions) | 0.08s |
| 3 | `gk inventory --target pi --json` | ok (0 agents, 0 skills) | 0.07s |
| 4 | `gk template show audit-pr` | ok (metadata only) | 0.09s |
| 5 | `gk template materialize audit-pr --params '{"task":"…"}' --use` | **FAIL GRAPHKIT_NOT_INITIALIZED** | 0.09s |
| 6 | `gk init` | ok (undocumented prerequisite) | 0.10s |
| 7 | `gk template materialize … --use` | ok → id `2026-10-06-audit-pr`, active set | 0.08s |
| 8 | `gk validate graph.yaml --json` (skill's literal cmd) | **FAIL GRAPH_FILE_NOT_FOUND** | 0.07s |
| 9 | `gk validate .graphkit/graphs/2026-10-06-audit-pr.yaml --json` | ok | 0.08s |
| 10 | `gk run start --graph 2026-10-06-audit-pr --json` | **FAIL GRAPH_NOT_FOUND** | 0.08s |
| 11 | `gk run start --graph <full path> --json` | **FAIL MISSING_INPUTS (task)** | 0.07s |
| 12 | `gk run start --graph <path> --input task=… --json` | ok → run `20261006-143214-audit-pr` | 0.12s |
| 13 | `gk graph agents` | **FAIL GRAPH_FILE_NOT_FOUND** (defaults ./graph.yaml) | 0.07s |
| 14 | `gk graph agents <path>` | **FAIL AGENTS_DIR_MISSING** | 0.08s |
| 15 | `gk init --target pi` (SECOND init) | ok | 0.11s |
| 16 | `gk graph agents <path>` | ok → `{reviewer: gk-reviewer, …}` | 0.09s |
| 17 | `gk run dispatch reviewer --via task --json` | ok | 0.09s |
| 18 | `gk run node reviewer --status ok --agent gk-reviewer --evidence audit-findings --duration-ms 42000 --json` | ok | 0.08s |
| 19 | `gk run end --status merged --json` | ok — 1/3 nodes, 0/1 required evidence, still `merged` | 0.12s |

Tally: **19 commands, 6 failures, 12 distinct subcommands**. LLM-side steps the skill also requires: template selection reasoning, param collection, gap analysis, per-node change review (SKILL.md:44-54).

### Flow 2 — guided ONLY by gk-execute/SKILL.md (fresh dir, same graph)
| # | command | result | wall |
|---|---------|--------|------|
| 1 | `gk graph waves graph.yaml --json` (skill's literal cmd) | **FAIL GRAPH_FILE_NOT_FOUND** | 0.10s |
| 2 | `gk graph waves <path> --json` | ok — 3 waves | 0.09s |
| 3 | `gk run start --graph <path> --input task=… --json` | ok → run `20261006-143541-audit-pr` | 0.11s |
| 4 | `gk graph agents <path>` | **FAIL AGENTS_DIR_MISSING** | 0.09s |
| 5 | `gk init --target pi` | ok | 0.11s |
| 6 | `gk graph agents <path>` | ok | 0.15s |
| 7-9 | `gk run dispatch {reviewer,verifier,synthesizer} --attempt 1 --via task` ×3 | ok | ~0.09s ea |
| 10-12 | `gk run node … --status ok --wave {0,1,2} --agent gk-… --evidence … --duration-ms …` ×3 | ok | ~0.08s ea |
| 13-15 | write `.graphkit/evidence/{audit-findings,verified-findings,audit-report}.md` | file writes | — |
| 16-18 | `gk evidence add <file> --key <k> --node <n>` ×3 | ok (rewrites file w/ fingerprint) | ~0.1s ea |
| 19 | `gk gate <path> --json` | MERGE (checks only `required_keys`) | 0.11s |
| 20 | `gk run end --status merged --json` | ok | 0.10s |
| 21 | `gk memory consolidate --json` | ok | 0.07s |

Tally: **21 commands (15 gk + 3 file writes + 3 evidence adds), 2 failures**. Plus protocol-internal steps from the skill: hub-jobs snapshot per wave, message stamping `run:/node:/rev:`, dispatch-intent-before-batch, CHALLENGE/when/gate/loop/advisor checks per node.

### Divergences flow2 vs flow1 (count: 6)
1. Graph location: session graphs (`.graphkit/graphs/`) vs skill-literal `./graph.yaml` — execute step 1 fails on init's output.
2. Identity: materialize returns an id that run start rejects; execute assumes path.
3. Agent materialization prerequisite (`gk init --target pi`) absent from both skills at point of need.
4. End protocol: flow 1 ends ungated (accepted incomplete run); flow 2 mandates gate MERGE + consolidate. Same CLI, two contracts.
5. Recording grammar: execute adds `--wave`/`--attempt`/dispatch-intent/hub-snapshot/stamping — unknown to init-graph reader; loop semantics depend on them but flags are optional.
6. Path resolution asymmetry: run start honors active-pointer-on-omission; waves/agents/validate/gate don't.

### State a user/agent must hold (intent → running graph)
graph path **or** nothing (undocumented active-omission); graph id (dead weight); run id; `graph_sha256` (stamping); input key names; node ids; materialized agent names `gk-<node>` (≠ node id ≠ graph `agent:` field); evidence keys per node + `<evidence_dir>/<key>.md` convention + required_keys subset; wave indices; attempt numbers; `--via` enum; two `--status` enums; TWO init invocations with different targets.

### Headline numbers
- Intent → first running graph, informed user, zero failures: **9 CLI commands** (init, template list, suggest, inventory, template show, materialize, validate, run start, graph agents). Literal skill-following: **19 commands, 6 failures**.
- Intent → completed 3-node run: **24 gk invocations + 3 evidence file writes + 3 task() batches + 2 skills read (482 lines)**. Zero of those commands do model work.
- Mandatory flags across the flow: **8** (`--params`, `--use`, `--input`, `--via`, `--status` ×2, plus `--graph`-or-omission decision, `--evidence` effectively required for meaningful ledger).
- Distinct failure modes: **8 occurrences → 4 root causes** (init-target gap ×2, identity mismatch ×3, skill path contract ×2, input enforcement ×1).

## SOLID-lens
- **SRP**: the CLI is a ledger/state machine; the orchestration protocol lives in prose SKILL.md. Two sources of truth for one protocol (init vs execute disagree on path + end contract); the "compiler" is the LLM reading both.
- **OCP**: dispatch transport details leak into user flags (`--via task|extension`, `--pid`); a third transport would extend user-facing grammar instead of staying internal.
- **LSP**: graph identifiers are not substitutable across commands (id vs path vs omission) — same concept, different accepted forms per subcommand.
- **ISP**: one `gk run` command group exposes all 17 options to every subcommand; per-subcommand minimal interfaces are buried in example strings.
- **DIP**: policy (gate-before-end, stamp-before-gate, dispatch-intent-before-batch) is enforced by agent discipline, not by the mechanism — flow 1 proves the drift is real (ungated `merged` accepted).

## Kill-or-keep
**Kill/merge**
- Graph id as a user-facing token: accept id everywhere (one resolver: path | id | active for validate/waves/agents/gate/run) or stop returning it.
- `gk run dispatch` + `gk run node` as separate mandatory steps → single upsert (dispatch returns a token the node record consumes, or auto-record).
- Evidence write + `gk evidence add` split → one `gk evidence write --key k --node n` (or `gk run node --evidence-file`).
- The two-init dance: `gk init` should cover the default target including `.omp/agents`.
- Per-command path resolution rules → one shared resolver.
**Keep**
- `gk graph waves --json` — single authoritative execution order payload.
- Run ledger + `resume`/`take` + RUN_ACTIVE guard.
- `gk gate` with fingerprints/artifacts — but make `gk run end` invoke it when `required_keys` exist (closes F4).
- Immutable session graphs + active pointer (extend its reach, don't remove it).
- `gk template materialize --use` one-shot write+activate.
**Add (re-arch)**
- One-shot `gk up` (init → materialize → validate → run start → agents): collapses 9 commands to 1–2.
- `gk run node --evidence-file` stamping on record: collapses evidence ceremony 2N → N.
