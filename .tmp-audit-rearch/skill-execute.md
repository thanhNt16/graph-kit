# gk-execute audit (recovered + completed; prior agent SkillExecute verified everything but was interrupted before writing)

Scope: `kits/_core/skills/gk-execute/SKILL.md` (380 ln, read fully), `src/cli/commands/run.ts` (448 ln), `src/cli/command-registry.ts`, plus targeted verification in `graph.ts`, `ledger.ts`, `analyze.ts`, `evidence.ts`, `gate.ts`, `graph.schema.ts`.

## Findings

Severity-ordered. All file:line personally verified unless noted.

### F1 · HIGH — The skill is an unwritten runner: ~5 mechanical CLI calls per node, all orchestrator bookkeeping
The per-node happy path the skill mandates (SKILL.md:102, 55-59, 167): `gk run dispatch` (pre-spawn intent) → spawn → `hub jobs` liveness re-check → `gk run node --status ok --wave --agent --evidence --duration-ms` (trace) → `gk evidence add --key --node` ×K. Only the spawn needs agent judgment; intent, trace, and stamp are 100% derivable from the dispatch result. The codebase already knows this pattern: `on_node_complete` hooks are pre-rendered command strings that ride the waves payload so the orchestrator doesn't hand-write the trace line (`src/cli/commands/graph.ts:900-928`) — but that's the only automated seam, and `on_fanout_dispatch` is declared-but-unused ("no consumer exists", graph.ts:901-902). Evidence: counts in Friction-log below.

### F2 · HIGH — Takeover safety guard cannot protect the default dispatch path
`gk run take` refuses while recorded dispatch pids are alive (`run.ts:306-317`, `liveDispatchPids` EPERM/ESRCH split at 108-123 — good contract). But pids are only recordable for extension dispatches (`--pid`, SKILL.md:102); native `task` spawns have no pid, so a same-tree wave — the default mode — leaves zero live-pid evidence. `take` during a live native wave succeeds and invites double-dispatch. The one step the skill marks safety-critical (refusing takeover) under-protects the common case. Compounded by F8: advisor pids escape too.

### F3 · MED — `INJECTION:` protocol is a prose contract with zero code support, spread across three artifacts
The curator's machine-readable output ("final non-empty line must be exactly `INJECTION: <reminder>`", SKILL.md:90-92) is parsed by the orchestrator LLM. No src code knows the string (grep: `INJECTION` absent from src/). The contract lives in (a) SKILL.md, (b) the memory-curator agent file, (c) the curator node objective template rendered inside `graph.ts:415-419` (evidence keys `memory_delta, injection_decision`). Three authorities, no enforcement, safe fallback on malformed (inject nothing — good). Also unspecified: whether "trace EVERY node" (SKILL.md:55) covers curator waves, and who writes/stamps the curator's `memory_delta`/`injection_decision` evidence files.

### F4 · MED — Skill contradicts itself on curator skills
Step 2: "dispatch … the Memory Curator … **with the gk-recall skill**" (SKILL.md:90). Line 107: "Node model, tools … and `skills` are already baked into the materialized `gk-<node>` agent — **do not restate them per call**." Code agrees with line 107: gk-recall is merged into the materialized curator agent (`graph.ts:934`). The curator instruction violates the skill's own rule three lines of context away.

### F5 · MED — Supervisor role spec is incoherent
"A supervisor node runs read-only across a whole wave's outputs … It does not gate the wave barrier … its own dispatch is a normal node in its wave, **alongside the nodes it reviews**" (SKILL.md:296). A node cannot review outputs of nodes running concurrently with it. Either it sits in wave N reviewing wave N−1 (then "alongside the nodes it reviews" is false), or it must run after the wave (then "normal node in its wave" is false). Barrier interplay undefined → orchestrator improvises.

### F6 · LOW-MED — Registry usage drift: `evidence add --node` missing from the derived-surface registry
Skill requires `gk evidence add <file> --key <k> --node <node-id>` (SKILL.md:167, 370). The command accepts `--node` (`evidence.ts:27`) but `command-registry.ts:84` usage line omits it. The registry header claims "derived — not hand-synced" — true for names, false for `Leaf.usage` prose, which is hand-maintained and already drifting.

### F7 · LOW — "Run hooks verbatim" contradicts its own `{node}` substitution
SKILL.md:64-66: "run those command strings **verbatim** … `{node}` in the string substitutes the node id." Substitution is agent-side (payload attaches one shared array to every node, `graph.ts:928`; no code substitutes). Verbatim + templating is a contradiction the orchestrator must resolve every node.

### F8 · LOW — Advisor dispatch intents are unrecordable
`gk run dispatch` validates the node id against the graph (`run.ts:275-279`, UNKNOWN_NODE) and rejects pids of foreign agents. Advisors are not graph nodes, so the skill's `--via extension` rule (SKILL.md:102) cannot be followed for advisor spawns — their ledger line and their pid both vanish (weakens F2's guard further).

### F9 · LOW — `gk graph agents` staleness is a manual ritual
"Re-run it if the graph changes mid-run" (SKILL.md:96) — no hash check, though the ledger already stores `graph_sha256` (`ledger.ts:152`). A drifted materialization silently dispatches stale agents.

### F10 · LOW — Worktree re-stamping amplification
Every merge changes the repo fingerprint, invalidating ALL of that wave's evidence stamps: re-run `gk evidence add` for every key of every node, per wave (SKILL.md:314), plus `run land` per node, plus ~6 git commands per node and per-wave suite runs. Pure ceremony, O(nodes×keys) restamps — fully mechanical.

### F11 · INFO — Doc-vs-code matches (verified, no drift)
- All 10 `run` subcommands + every flag the skill cites exist: start/node/dispatch/land/take/end/resume/round/status/analyze; `--advisor-fired --streak --via task|extension --pid --from --commit --attempt --wave --evidence --duration-ms --notes --from-node --dry-run --force` (`run.ts:128-148`; registry 67-82).
- Hooks passthrough (`on_node_complete` per node, SKILL.md:64-66) = `graph.ts:903,928`. ✓
- Curator waves `curator: true` + recall skill baked, cadence-interleaved, end-of-run curator always appended (`graph.ts:846-898, 933-935`) ✓ matches skill's "emitted by memory-augmented graphs at cadence".
- Challenge disposition: `DISPOSITION_PATTERN = /\bdisposition=(\w+)/` — any value counts, canonical accept/modify/reject/defer documented (`ledger.ts:22-29`); `analyze.ts:80-91,160-163` tallies + flags unadjudicated last-word challenges ✓ matches SKILL.md:134.
- `timeout_ms` routes to extension, default 600000 (`graph.schema.ts:125-128`) ✓.
- Message stamping fields real: start payload `{ id, graph_sha256 }` (`ledger.ts:123,152`) ✓ SKILL.md:104.
- Dangling-active recovery: `RUN_ACTIVE` (`ledger.ts:125,186`); `take` clears dangling pointer with full recovery payload (`run.ts:318-337`) ✓ SKILL.md:82-84.
- Resume payload `unresolved/pending/foreign_evidence` (`run.ts:344-353`) ✓ SKILL.md:76-81.
- `gk gate` is a real top-level command (`gate.ts:114`); strict freshness + `require_landed` BLOCK semantics (SKILL.md:380) match gate.ts marker/fingerprint grep surface.

### F12 · INFO — Skill contradicts itself structurally
"Step 1", "Step 1b", "Step 2" (SKILL.md:32-96) contain an inner numbered list 1-4 (materialize / dispatch / collect / loops / evidence) interleaved with unnumbered subsections (Dispatching a wave, CHALLENGE verdict, Advisor escalation, Fan-out), then "Step 3" after. Materialize — a once-per-run action — sits *inside* the per-wave list as item 1. An orchestrator executing linearly will re-materialize per wave or miss it.

## Friction-log

Every gk CLI / mandatory tool invocation the skill demands. K = evidence keys per node (≥1).

Per **node** (happy path, native dispatch, same-tree):
| # | Call | Source |
|---|---|---|
| 1 | `gk run dispatch <id> --attempt 1 --via task` | SKILL:102 |
| 2 | `hub jobs` snapshot (wave-shared, but per-node row check) | SKILL:102 |
| 3 | `gk run node <id> --status ok --wave N --agent … --evidence … --duration-ms` | SKILL:55-59 |
| 4.. | `gk evidence add <dir>/<k>.md --key <k> --node <id>` ×K | SKILL:167 |

Per **wave**: `hub jobs` ×1; loop groups +`gk run round <i>` per round (SKILL:339).
Per **run** fixed: `graph waves`, `run start`, `graph agents`, `gate`, `run end`, `memory consolidate` = **6** (SKILL:35,43,96,375,70-72).
Conditionals per node: `require_landed`/worktree +`run land --commit`; worktree +K re-stamps +~6 git cmds; retry +1 dispatch-intent +1 spawn/attempt; advisor cycle +1 `gk_dispatch_agent` +1 `run node --advisor-fired`; challenge +1 `run node <challenged> --status challenge --notes disposition=…`; `when`-skip or gate-reject +1 skipped trace; crash recovery +`run status` +`resume`/`take`.

**Totals (K=1, zero failures):**
- 3-wave diamond (src → 2 workers → sink; 4 nodes): 6 fixed + 3 wave + 4×2 node = **17 gk calls**, +4 task spawns → **21 tool invocations for 4 nodes** (5.25/node).
- 5-node pipeline (5 waves): 6 + 5 + 10 = **21 gk calls**, +5 spawns → **26 for 5 nodes** (5.2/node).
- Skill's own example (5 nodes, 3 waves, 3 workers, SKILL:177-187): 6 + 3 + 10 = **19 gk**, +5 spawns → **24** (4.8/node).
- Memory-augmented: +2 curator ledger calls per curator fire (+2 more if curator evidence stamping is enforced — unspecified, F3).
- Worktree wave of 2 writers: +2 land, +2K restamps, ~12 git ops, 2 suite runs, per wave.

Rule of thumb: **the ledger protocol costs ≈ the dispatch itself ×4-5**. A 15-node graph ≈ 70-90 mechanical invocations before any judgment.

## SOLID-lens

- **SRP — violated hardest.** SKILL.md is six documents in one: dispatch protocol, ledger API reference, retry/backoff policy engine (SKILL:227-235 — the CLI could own this), worktree runbook (304-321), loop-semantics spec (323-346), and marketing ("Why this is effective" / "vs compiled", 348-365). The orchestrator must hold all ~380 lines as working context on every run, including for graphs that use none of it. This is the friction multiplier behind F1.
- **OCP — violated.** Each new orchestration field (retry/when/budget/gate/fan_out/effort/timeout_ms/role = 8 prose sections, 227-296) adds orchestrator-side enforcement duties with no code support. Extension = writing more skill prose, not more capability.
- **LSP — violated.** `--via task` and `--via extension` are interchangeable in the ledger schema but not in behavior: only extension records a pid, so only extension is protected by the takeover guard (F2). Substitutability assumed by the ledger, broken by the transport.
- **ISP — violated.** No progressive disclosure: a 5-node plain DAG still requires the orchestrator to ingest curator protocol, loop groups, worktree merge protocol, advisor ladders, fan_out reduce semantics. The waves payload already knows which features a graph uses (`fan_out: null`, `loop: null`, `advisor: null` per node, graph.ts:912-926) — the skill never branches on it.
- **DIP — violated.** Code renders prose that the skill then tells the agent to parse: curator objective text + INJECTION convention rendered from `graph.ts:415-419`, consumed by an LLM reading SKILL.md:90. The contract's authority lives in prose in three places (F3) instead of a schema/enum the CLI emits and validates.

## Kill-or-keep

**Kill / mechanize (ceremony, zero judgment):**

- Per-node dispatch-intent + trace lines + evidence stamps → derive from spawn result inside the runner (F1).
- `hub jobs` liveness double-check per wave → runner asserts one row per spawn.
- Manual wave-index threading (`--wave N`), manual budget char/4 estimation + spill (SKILL:249-251), manual `{node}` substitution (F7), manual agents-staleness (F9 — diff against recorded `graph_sha256`), worktree re-stamp amplification (F10).
- "Why this is effective" + "vs compiled" sections (~20 lines of SKILL.md) — marketing, delete.
- `on_fanout_dispatch` in the schema default — declared-but-unused per the code's own comment (graph.ts:901); remove or implement.

**Keep (safety-critical, stays agent/human judgment):**

- `gate` suspension → human approval (SKILL:253-259).
- `CHALLENGE: plan` → never auto-adjudicated, suspend for human (SKILL:134); disposition choice itself.
- `stop_when` / `when` natural-language judgments (SKILL:241-243, 342).
- Takeover `unresolved` review with the user before re-dispatch (SKILL:76-84) — and fix the guard gap (F2/F8) rather than drop it.
- Worktree conflict → abort-and-stop policy (SKILL:310): detection is mechanical, the stop/report is safety.
- Strict evidence freshness / `require_landed` BLOCK (SKILL:380) — the anti-fabrication backbone.

**Proposed `gk run exec` split:**

- *Mechanize in a single loop:* wave scheduling + barrier; timeout_ms→extension vs task routing; retry/backoff/`non_retryable` matching; intent+trace+stamp writes; round journal + no-progress fingerprints; worktree lifecycle (add/merge/conflict-detect/owns-check/land/re-stamp/remove/orphan report — orphan scanning already exists, `orphanedGkArtifacts` run.ts:34-53); agents materialization with sha staleness; message-stamp headers injected into briefs; budget compaction; hooks execution. Fold `run end` + `consolidate` + `gate` into exec exit.
- *Emit as decision points, pause for the orchestrator:* `{type: gate|challenge|stop_when|when|injection|unresolved}` structured requests the agent (or user) answers, then exec continues. The curator stays a dispatched agent; exec surfaces its output for the orchestrator's injection decision instead of asking the agent to LLM-parse a terminal line.
- *Minimal variant if full exec is too big:* `gk run script --wave N` — emit the wave's mechanical command block (generalizes the existing hooks pattern, graph.ts:900) so the orchestrator pastes 1 block per wave instead of 5 calls per node.
