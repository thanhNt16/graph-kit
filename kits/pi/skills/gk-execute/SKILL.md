---
name: gk-execute
description: Execute a graph.yaml by dispatching native subagents via the task tool (gk_dispatch_agent only for hard timeout_ms budgets) — no compilation. Transparent, real-time, interactive. Optional worktree mode (--worktree / "batch") isolates write nodes in git worktrees. Trigger: "execute graph", "run graph directly", "spawn agents for graph", "batch the graph".
when_to_use: User wants to execute a graph with full visibility — see each node dispatch and result, watch progress, debug failures. Use worktree mode when a wave has 2+ write nodes with overlapping scopes.
user-invocable: true
disable-model-invocation: false
---

# gk execute

## Purpose

Execute a graph.yaml by **dispatching native subagents via the task tool** — YOU are the orchestrator. `gk graph agents` materializes each node as a discoverable `.omp/agents/gk-<node>.md` agent (model/tools/skills baked in); each node becomes one task spawn you can see and monitor. `gk_dispatch_agent` remains only for nodes needing a hard wall-clock kill (`timeout_ms`).

This is direct execution from graph.yaml — there is no compile step in this kit. Use this when you want:
- Real-time visibility into each node's execution
- Ability to debug/adapt when a node fails
- Interactive control (pause, ask user, resume)
- No compilation step

## Dispatch modes

| Mode | When | How |
|---|---|---|
| **Same-tree** (default) | Read-heavy waves, ≤3 writers with clean file scopes | plain sequential dispatches; the plan partitions files via an ownership map |
| **Worktree** (`--worktree`, "batch the graph", "run in worktrees") | 2+ write nodes per wave whose scopes overlap or would need an ownership map | each write-capable node runs inside its own `git worktree` branch — collisions become impossible |

Escalate same-tree → worktree when you catch yourself drawing an ownership map. Escalate worktree → same-tree (sequenced via `depend_on`) only if the repo isn't git or the host lacks worktree support.

## Process

### Step 1: Get the wave structure

```bash
gk graph waves graph.yaml --json
```

This outputs the topological wave structure — which nodes run in parallel, which wait for dependencies. Parse the JSON to understand execution order.

### Step 1b: Start the run ledger

```bash
gk run start --graph graph.yaml --json
```

Before dispatching wave 1, start the ledger. If it fails with `RUN_ACTIVE`, a previous
run never ended — ask the user, or run `gk run status` to inspect, before proceeding.

If the `gk run start` payload carries `warnings`, read them: a `kitVersion` mismatch means this project's installed kit (skills/extensions/rules) predates the running gk binary — run `gk init --target <target>` to refresh before dispatching, or nodes may execute under outdated semantics.

### Recording nodes

After EVERY node dispatch returns (ok or fail), append a trace line:

```bash
gk run node <node-id> --status ok|fail --wave <wave-index> --agent <agent> --evidence <comma,keys> --duration-ms <ms>
```

A failed dispatch (ok:false) MUST be recorded with `--status fail` BEFORE stopping the
graph — the failure pattern is exactly what `gk memory consolidate` later surfaces.

If the waves payload carries `hooks: [...]` on a node, run those command strings
verbatim instead of hand-writing the equivalent `gk run node` call; `{node}` in the
string substitutes the node id.

### Ending

After the final wave (and the evidence gate): `gk run end --status merged|blocked|failed`,
then `gk memory consolidate --json`. If the payload has `on_graph_complete`, run those
commands verbatim — `gk run end` + `gk memory consolidate` are what they normally contain.

### Resume & takeover

A run interrupted mid-graph resumes from the ledger, never from memory:

1. `gk run status` inspects the latest run; `gk run resume <run-id>` replays the plan —
   satisfied nodes stay done, skipped nodes stay skipped. The resume payload carries an
   `unresolved` list (nodes whose dispatch intent has no trace line): surface it to the
   user and decide with them BEFORE re-dispatching any of it.
2. A stale `.active` file (a run died without `gk run end`) blocks `gk run start` with
   `RUN_ACTIVE`: `gk run take --from <old-run-id>` clears it — refusing while any
   recorded dispatch pid is still alive — and returns the same `unresolved` list to act on.

### Step 2: Execute wave by wave

For each wave in the output:

**Curator waves (`wave.curator === true`):** if the wave is a curator wave (emitted by `memory-augmented` graphs at cadence), dispatch its single node — the **Memory Curator** (`memory-curator`) — with the gk-recall skill. Pass it the evidence paths written by the just-completed action wave. Curator calls are excluded from cadence counting — cadence counts completed **action-node** executions only, so a curator wave never triggers another. Read the curator's terminal line — its final non-empty line must be exactly `INJECTION: <reminder>` or `INJECTION: null`; parse only that line and treat it as the `injection_decision`:
- If the terminal line is `INJECTION: <reminder>` (non-null): prepend `[memory] <reminder>` to the **next** action wave's node `objective`(s).
- If `INJECTION: null` or malformed output (terminal line missing/unparseable): log a diagnostic to stderr and inject nothing — a malformed terminal line never blocks the action node.

Then continue to the next wave — skip the action-wave steps below for curator waves.

1. **Materialize node agents** — run `gk graph agents <graph.yaml>` once after `gk run start`. It writes `.omp/agents/gk-<node-id>.md` (frontmatter: name, description, node `model`, constraint-derived `tools`, `autoloadSkills` from node `skills`) so omp's native task discovery can dispatch each node directly. Re-run it if the graph changes mid-run.

## Dispatching a wave (pi)

Use the native **task** tool — one batch call per wave: `task({ context: "<shared upstream context>", tasks: [{ name: "<node-id>", agent: "gk-<node-id>", task: "<node.objective + upstream results + refs>" }, ...] })`. All nodes of the wave go in one `tasks[]` array; they run in parallel and results auto-deliver. Collect every result, then proceed.

**Dispatch intent.** Before each `task()` batch, record every spawn's intent: `gk run dispatch <node-id> --attempt <n> --via task` (use `--via extension` immediately before a `gk_dispatch_agent` call, adding `--pid` when the child pid is known). After the batch, snapshot `hub jobs`: it must show one running row per spawned node BEFORE the wave wait. A node with no row never launched — `gk run node <id> --status fail --notes launch-lost` and stop the wave.

**Message stamping.** Every `hub send` to a node and every task brief opens with a header `run: <run-id> node: <node-id> rev: <graph_sha256[:12]>` — run id and hash come straight from the `gk run start` payload, so a relayed message is traceable to its run out-of-band.
Wave barrier: do NOT start wave N+1 until every node of wave N returned (exitCode 0). The same barrier holds across loop rounds — do not start round N+1 until every node of a loop group's last wave returned.
A failed node (nonzero exitCode / error / aborted) stops the graph: report node name, objective, and error output — unless the node declares `retry` for a transient failure (see [Orchestration fields](#orchestration-fields)). Before dispatching a node, check its `when` (skip if false) and `gate` (suspend for approval).
Node `model`, `tools`, `no_write`/`no_exec` constraints, and `skills` are already baked into the materialized `gk-<node>` agent — do not restate them per call.
If the node declares `assumptions`, append to its task text: `Premises listed as challengeable may be reopened with evidence; constraints may not.`

**Exception — hard kill budgets:** a node declaring `timeout_ms` needs a wall-clock kill the task tool can't express per-spawn. Dispatch it via `gk_dispatch_agent` (the gk-subagent extension) with `timeout_ms` — it kills the whole child process group on expiry. Everything else uses native `task`.

Each task item gets:
   - `name`: the node id (becomes the agent registry id)
   - `agent`: `gk-<node-id>` (the materialized agent)
   - `task`: the node's `objective`, plus upstream results from `depend_on` nodes and its `refs` (mention these files)
   - shared `context`: run-level background (graph name, evidence dir, prior-wave verdicts)

   In **worktree mode**: for each write-capable node, create an isolated worktree first (`git worktree add .graphkit/worktrees/<node-id> -b gk/<node-id>`), run the dispatch with the worktree path in the task, and make tasks fully self-contained (workers cannot ask the user) — include repo conventions, the node's acceptance-check recipe, and landing instructions (commit to the worktree branch, conventional message). Read-only nodes skip worktrees — plain dispatch.

2. **Collect results** — when all dispatches in the wave return ok:true, collect their outputs.
   In **worktree mode** a wave is NOT done when agents return — it is done when
   merged and the gate is green (see Worktree merge protocol below).

### CHALLENGE verdict — third node outcome

A node's result is ok, fail, or **challenge**. A result MAY end with a final line:

```
CHALLENGE: <node-id|plan> — <evidence>
```

meaning: evidence found during the work indicates an upstream premise or the plan itself is wrong. Handle one:

1. Record it AND the adjudicated disposition in one line: `gk run node <challenged-id> --status challenge --evidence <keys> --notes "disposition=accept|modify|reject|defer reason=…"` — the disposition is what `gk memory consolidate` parses. A `CHALLENGE: plan` (the plan itself challenged) is never auto-adjudicated: suspend the run via a node `gate` for human approval and let the user decide.
2. Adjudicate:
   - **Decision-changing** — re-dispatch the challenged upstream node's owner with the finding appended under `## Challenged premise`, or fire a `gk_dispatch_agent` advisor to assess when the impact is unclear.
   - **Equally-valid alternative** — note it in the run report and continue.
   - **Noise** — ignore.
3. A re-dispatch carries the original objective PLUS the challenge evidence; its `assumptions` list is fair game to revise.

**Dissent rule:** challenge is a RIGHT gated on concrete evidence (reproduction, citation, measurement), never an obligation. Agents that invent dissent burn tokens; orchestrators that rubber-stamp every challenge create churn.

3. **Handle loops** — per-node `loop.enabled`: if the result doesn't satisfy its `stop_when`, re-dispatch that node (up to `max_rounds`). Top-level `loops:` (multi-node groups): see [Loop groups](#loop-groups-multi-node-loops) below — the hybrid stop ladder replaces the advisory-only rule.

### Advisor escalation

When a node's payload carries `advisor`:

1. Track the failed-round streak while looping the node (a round fails when `stop_when` is unmet, the agent exits non-zero, or required evidence is missing).
2. When streak ≥ `advisor.after_failed_rounds` AND advisor calls this run < `advisor.max_calls`: dispatch a read-only advisor subagent via `gk_dispatch_agent` with `constraints: { no_write: true }` BEFORE the next node round (advisors stay on the extension path — they need a per-call model override the materialized agents don't carry):
   - model tier = `advisor.model`; tools: none beyond read; MUST NOT edit files.
   - input: the node's objective, the last round's output, and the failure evidence.
   - ask for: a diagnosis and the single next action.
3. Record the escalation: `gk run node <id> --advisor-fired <round> --streak <n>`.
4. Append the advice to the node's objective under an `## Advisor guidance` heading and re-dispatch the NODE at its original model tier.
5. If `max_calls` is reached or `max_rounds` is exhausted, take the existing failure path.

### Fan-out execution

When a node's payload carries `fan_out`:

1. Read `briefs.json` (a JSON array of `{id, title, body}`) from the evidence of node `fan_out.briefs_from`. Missing/malformed file = a failed round for this node (normal loop semantics; advisor may then fire).
2. Dispatch one task item per brief in a single batch call (`agent: "gk-<node-id>"`, `name: "<node-id>-<brief.id>"`), task = `fan_out.template` rendered with the brief (default template `{brief.body}`). Subagents run at the NODE's model tier (baked into the materialized agent).
3. Barrier on all briefs; only successful results count toward the barrier; combine their outputs per `fan_out.reduce` (default `append` — see [Orchestration fields](#orchestration-fields)) into this node's evidence and final output. Any failed brief marks the round failed.
4. Empty briefs array: node output is "no briefs" — ok status.

4. **Write evidence** — write one non-whitespace file per declared evidence key (`<evidence_dir>/<key>.md`), then stamp each via `gk evidence add <file> --key <key> --node <node-id>`. The stamp carries the repo-fingerprint marker; markerless evidence fails `strict` freshness at the gate (see [Evidence gate](#evidence-gate)).


### Step 3: After all waves complete

Write a summary to `.graphkit/reports/<graph-name>.md` with:
- Each node's verdict/output
- Evidence coverage check (all `required_keys` present?)
- Overall verdict (passed/failed/partial)

## Example: Diamond with 3 workers

```
Wave 0: [scouter]                    → 1 agent (opus)
Wave 1: [worker-a, worker-b, worker-c] → 3 agents in parallel (sonnet)
Wave 2: [synthesizer]                 → 1 agent (opus)
```

- Wave 0: dispatch scouter, wait for ok:true
- Wave 1: dispatch worker-a, worker-b, worker-c, wait for all 3
- Wave 2: pass all 3 results to synthesizer, dispatch it

## Dispatch call shape

```
task({
  context: "<run-level background: graph name, evidence dir, prior verdicts>",
  tasks: [{
    name: "<node-id>",              // becomes the agent registry id
    agent: "gk-<node-id>",          // materialized by `gk graph agents`
    task: "<node.objective> + <upstream results> + <refs>"
  }]
})
```

Results arrive as async deliveries (or inline when the call settles); each spawn's `exitCode`/`error`/`aborted` decides success. Full output at `agent://<name>`; transcript at `history://<name>`; cancel via `hub`.

**`gk_dispatch_agent` fallback** (only for `timeout_ms` nodes and advisor escalations):

```
gk_dispatch_agent({
  agent: "<node.agent>",          // must match .omp/agents/<name>.md
  objective: "<node.objective>",
  context: "<upstream results, refs, acceptance recipe>",
  constraints: {                  // only when the node declares them
    no_write: true,
    tools_allowlist: ["read", "grep", "bash"]
  },
  timeout_ms: 600000              // node.timeout_ms when declared; else omit (default 600000)
})
```

The result is `{ ok, output, exit_code, timed_out? }`. Only `ok:true` counts toward the wave barrier.

**Timeout semantics.** On timeout the child's whole process group is terminated (SIGTERM, then SIGKILL after ~5s) and the result is `{ ok:false, exit_code:124, timed_out:true }` with a `TIMEOUT` marker in `output`. The kill is of the process, not its side effects: partial work (files written, DB rows, API calls) persists. Before re-dispatching a timed-out node, inspect what landed and make the retry objective resume-aware — never assume a clean slate. For nodes whose work can exceed 10 min (bulk ingestion, builds, migrations), declare `timeout_ms` on the node and instruct the agent to checkpoint progress to a file so a resume dispatch can skip completed work.

## Orchestration fields

Nodes may declare optional orchestration fields. The schema validates them; you enforce them at dispatch time. `gk graph waves` output carries every field verbatim per node — read them from the wave payload, not from graph.yaml.

### `retry` — transient dispatch-failure policy

```yaml
retry: { max_attempts: 3, initial_interval_ms: 1000, backoff: 2.0, non_retryable: [TIMEOUT] }
```

Defaults: `max_attempts: 1` (no retry), `initial_interval_ms: 1000`, `backoff: 2.0` (exponential), `non_retryable: []`.

**Retry ONLY transient dispatch failures** — infrastructure errors: the dispatch tool itself errored, agent binary crashed, transport timeout. Prompt, parse, and validation errors are NEVER retried: the input was wrong, retrying repeats it. Before retry N+1 (0-indexed from 1): wait `initial_interval_ms * backoff^(N-1)` ms. An error string matching (case-insensitive, substring) any `non_retryable` entry is fatal even within budget. Attempts exhausted → treat as a failed node (stop the graph, report attempts made). Record attempts in the run report.

### `when` — conditional skip

```yaml
when: "no security findings were reported by upstream audit"
```

Natural-language predicate over upstream node results — judge it yourself (same read-and-judge pattern as `stop_when`), evaluated just before the node's dispatch, after its wave barrier. False → **skip the node**: record it via `gk run node <id> --status skipped`, do NOT dispatch, downstream nodes see it as satisfied for the wave barrier with no output to inject. Skips are recorded, never silent.

### `budget_tokens` — advisory context cap

```yaml
budget_tokens: 4000
```

Cap on the upstream context injected into the dispatch. Rough-estimate tokens (~chars/4); if injected upstream context exceeds the cap: compact (summarize per upstream node, keep verdicts/decisions/evidence keys, drop prose) and spill the full text to `.graphkit/artifacts/<node-id>-input.md`, passing the file path instead. Budgets are advisory — never truncate a verdict, evidence key, or acceptance recipe below usefulness.

### `gate` — human approval before dispatch

```yaml
gate: { question: "Deploy to staging?", details: "Runs migrations" }
```

Before dispatching a gated node, suspend the run: surface the question (+details) to the user and stop the wave loop — do NOT proceed past the barrier. On approval, continue normally; on rejection, record the node `skipped` and continue (downstream nodes judge `when` against that; a skipped node's dependents are skipped too — no evidence exists for them to consume). If the session dies mid-suspension, `gk run end` the stale run first, then `gk run resume` — skipped nodes stay skipped on resume (never re-asked). One gate pause per node.

### `fan_out` with `reduce` — fan out and reduce

```yaml
fan_out: { briefs_from: plan, template: "Implement {brief.title}: {brief.body}", reduce: merge }
```

`briefs_from` names an upstream node whose output (evidence key) is a JSON array; you dispatch one subagent per array item with `template` rendered per item (`{brief}` = the JSON item; `{brief.<field>}` = a field). `reduce` controls combining (default `append`):
- `append` — concatenate per-item outputs in order.
- `merge` — treat per-item outputs as partial views of one artifact; merge into a single coherent result.
- `vote` — judge per-item outputs against the node objective and keep the winning one (state the winner and why in the run report).

Record the reduced result as the node's output (and evidence). A fan_out node's dispatch count is items, not 1 — the wave barrier waits for all item dispatches.

### `effort` — dispatch scaling

```yaml
effort: deep   # node-level; default standard
```

`light` → single pass, tight `budget_tokens` (≤2000 if unset), 1 attempt, no parallel fan-out widening. `standard` → as declared. `deep` → widen: fan-out width doubles (dispatch up to 2× the `fan_out` items in parallel), loop `max_rounds` ×2 (round up), retry `max_attempts` +1, generous budget (≥8000 if unset). Effort scales the bounds declared on the node; it never overrides explicit user instructions mid-run.

### `timeout_ms` — per-node kill budget

```yaml
timeout_ms: 3600000
```

Declares a hard wall-clock kill budget. Its presence routes the node to `gk_dispatch_agent` (process-group kill on expiry) instead of native `task` dispatch — the task tool has no per-spawn timeout. Unset → native dispatch. Pair with a checkpoint instruction in the objective so a resume dispatch can skip completed work.

### `role: supervisor` — read-only cross-scope review

```yaml
role: supervisor
```

A supervisor node runs read-only across a whole wave's outputs and reviews cross-scope consistency (assumptions of A vs behavior of B). It emits `CHALLENGE:` freely (see [CHALLENGE verdict](#challenge-verdict--third-node-outcome)); it never writes code. It does not gate the wave barrier for other nodes — its own dispatch is a normal node in its wave, alongside the nodes it reviews.

## Steering

During a wave, `hub list` shows live node ids; relay human corrections mid-flight with `hub send <node-id> "<steering>"`.

When steering changes direction (not just unblocks a stuck node), record it in the run report AND write it to the evidence dir (e.g. `<evidence_dir>/steering.md`) so downstream nodes see it through shared state — not only in the steered agent's inbox.

## Worktree merge protocol (worktree mode)

After all agents in a wave finish (wait on notifications — never assume):

1. `git worktree list` → each worker's branch. Wave N+1's worktrees branch only after wave N's merges are committed into the main tree — never merge two waves concurrently.
2. Merge sequentially into the main tree in node order (`git merge --no-commit --no-ff <branch>`):
   - Conflict (unmerged paths / `UU` in `git status`): `git merge --abort` immediately, record `gk run node <id> --status fail --notes merge-conflict:<branch>`, stop the graph, and report node id, branch, and conflicting files — never hand-resolve mid-run and never start the next merge. Conflicts on the same lines are a plan smell; the graph should have sequenced those nodes via `depend_on`.
   - Clean merge: run the repo's test gate; seal with `git commit --no-edit` only while the gate stays green. A failing gate: stop and fix (or `git merge --abort`) before merging the next branch.
   - Post-merge owns check: `git diff --name-only` over the merge must be ⊆ the node's `owns` globs (when declared). A write outside owned scope → `git merge --abort`, `gk run node <id> --status fail --notes owns-violation`, stop.
   - Land it: once the merge commit seals, `gk run land <node-id> --commit <sha>` ties the node to its integration commit in the ledger.
   - Re-stamp evidence: the merge commit changes the repo fingerprint — re-run `gk evidence add <file> --key <key> --node <node-id>` for every key the node produced, or the gate reads it stale.
3. Remove worktrees (`git worktree remove`); keep branches until the whole graph passes. Open actual PRs only if the user asked.
4. After the last merge of the graph: rerun the repo suite and `gk gate` on the main tree — per-merge gates verified each branch; the final gate judges the integrated result.
5. `gk run end` reports orphaned `.graphkit/worktrees/*` directories and `gk/*` branches left on disk — clean them before reporting completion.

Graph authority is unchanged in worktree mode — topology, `depend_on` ordering, and loops still come from graph.yaml; worktrees are transport-level isolation only.

**Fallback (no worktree support):** same-tree mode with a strict per-node file ownership map; if files can't be partitioned, sequence the nodes via `depend_on` and re-validate.

## Loop groups (multi-node loops)

Top-level `loops:` repeats a **contiguous wave span** as a round trip (e.g. implement → test) until a stop condition. Semantics are authoritative in the design spec §4.3:

```yaml
loops:
  - nodes: [implement, test]      # required; contiguous wave span (validator-enforced)
    max_rounds: 5                 # required; ≥ 1 hard cap
    stop_when: "all tests pass"   # LLM-judged; required unless gate_evidence
    gate_evidence: [test-report]  # optional deterministic machine gate
    no_progress_limit: 2          # optional; fail early after N identical failing rounds
```

**Execution:** waves are computed once from the DAG. Walk waves normally; when you reach a loop group's head wave, enter the loop:

1. **Run a round** = one pass over the span's waves, dispatching normally. Round N outputs feed round N+1 node contexts.
2. **Record the round**: `gk run round <group-index>` after each pass — it appends a durable journal line and fingerprints the round's node statuses + evidence bytes. Do not skip it: round counts and no-progress detection come from this journal, not your memory.
3. **Hybrid stop ladder** — check in order:
   1. `gate_evidence` set and every listed `<evidence_dir>/<key>.md` exists and is non-whitespace → **stop: success** (deterministic, shell-testable).
   2. Else `stop_when` present → judge the previous round's node outputs against the text yourself (same LLM-read pattern as curator `INJECTION:` parsing). Satisfied → **stop: success**.
   3. Else read the `gk run round` response: `stop_reason: "no_progress"` (identical failing fingerprint `no_progress_limit` times) or `"max_rounds"` → **stop: fail the loop**; `null` → dispatch the next round.
4. **Evidence:** latest round wins — overwrite `<evidence_dir>/<key>.md` in place; never accumulate rounds.
5. **Exhaustion:** a failure stop (`no_progress` or `max_rounds`) → the loop fails and, per graph-stop rules, the whole run stops. Report rounds executed, last-round outputs, and which condition was being checked.
6. **Run report:** record rounds completed and stop reason per loop — `gate` | `judged` | `no_progress` | `exhausted`.

## Why this is effective

- **Transparent**: every dispatch and its result are visible in the conversation
- **Debuggable**: if a node fails (ok:false), you see the error output and can retry
- **Adaptive**: you can adjust objectives between waves based on results
- **No compilation**: skip `gk compile` entirely — execute directly from graph.yaml
- **Native**: dispatches through omp's own task tool (materialized `gk-<node>` agents), no child processes; `gk_dispatch_agent` only for hard kill budgets

## vs compiled workflows

| | gk-execute (this) | gk compile + runner |
|---|---|---|
| Visibility | Full — see every result | Opaque — background |
| Compilation | Not needed | Required (gk compile) |
| Debugging | Interactive | Hard |
| Speed | Same (parallel within waves) | Same |
| Scale | Good for <20 nodes | Better for 100+ nodes |
| Adaptivity | Can adjust mid-run | Fixed script |

## Evidence gate

Before reporting completion, write one non-whitespace file per declared evidence key —
`<graph.outputs.evidence_dir>/<key>.md` — and stamp each via `gk evidence add <file> --key <key> --node <node-id>`.

After all producer waves finish, run:

```bash
gk gate graph.yaml
```

The gate maps each required key `k` to `<evidence_dir>/<k>.md`. Missing or whitespace-only files produce `BLOCK` and exit 1; repair or redispatch only the producer for each missing/empty key, then rerun the gate. Only `MERGE` with exit 0 permits completion. The compiled workflow does not invoke the gate automatically.

Under `strict` freshness an unstamped (markerless) file is also a `BLOCK` — never write evidence by hand; always through `gk evidence add`. With `require_landed` on, evidence from a node recorded `ok` but never landed via `gk run land` BLOCKs too — land the node (or re-run the merge protocol) before the gate can pass. An `eval-gate` role node contributes its own MERGE/BLOCK verdict to this gate.
