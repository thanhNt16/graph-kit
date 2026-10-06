---
name: gk-execute
description: Execute a graph.yaml interactively — you dispatch every node via the task tool, watch each result land, and apply judgment (CHALLENGE adjudication, gate questions, worktree escalation). Deterministic protocol is engine-owned; `gk exec` runs the same engine headless. Trigger: "execute graph", "run graph directly", "spawn agents for graph", "batch the graph".
when_to_use: The run needs judgment in the loop — challenge adjudication, gate suspension, mid-run steering. For headless/no-interaction runs use `gk exec` (same engine, child-process dispatch).
user-invocable: true
disable-model-invocation: false
---

# gk execute

## Division of labor

YOU are the interactive orchestrator: dispatch nodes, watch results, apply judgment. The exec engine (`src/exec/engine.ts`, surfaced headless as `gk exec`) owns every deterministic step — wave barrier, retry/backoff, loops, advisor streaks, fan-out briefs, budget compaction, evidence stamping, unresolved reconciliation, ledger writes. The rule: if the engine does it, this skill does not restate it. Exception — the evidence gate: the engine never runs it, so interactive runs close it with a manual `gk gate <graph>` (step 6); headless runs stop at the engine verdict only.

Headless, no judgment needed: `gk exec graph.yaml [--json] [--worktree] [--yes]` — pass `--no-judge` only knowingly (`when:` nodes skip; `stop_when:` loops run to max_rounds; gates auto-skip).

## Interactive recipe

1. **Plan** — `gk graph waves graph.yaml --json`: waves of parallel nodes with orchestration fields verbatim; curator waves flagged `curator: true`; the `evidence_required` list.
2. **Open the ledger** — `gk run start --graph graph.yaml --json`. `RUN_ACTIVE` → inspect `gk run status` with the user first. Honor `warnings` (stale kit → `gk init --target <target>`) and required `--input name=value`s.
3. **Materialize agents** — `gk graph agents` writes `.omp/agents/gk-<node-id>.md` (model/tools/skills baked in); re-run it if the graph changes mid-run.
4. **Per wave — one batch dispatch** of all its nodes (call shape below), then one ledger line per returned node; the engine/ledger records the rest:
   `gk run node <node-id> --status ok|fail|skipped|challenge --wave <w> --agent <agent> --evidence <keys>`
   - node `when` judged false → skip: record `--status skipped`, dispatch nothing; dependents see it satisfied.
   - node `loop` with unmet `stop_when` → re-dispatch the node; round journaling is the ledger's.
   - a node with `evidence: [keys]` writes `<evidence_dir>/<key>.md` per key — pass the obligation + the evidence dir in its dispatch; `gk gate` (step 6) checks exactly those files.
   - mid-run steering (the frontmatter promise): `hub list` shows live dispatches, `hub send` redirects one; record direction changes in the evidence dir.
   - a `timeout_ms` node routes through `gk_dispatch_agent` (hard process-group kill), never plain task dispatch.
5. **Curator wave** (`curator: true`) — dispatch the memory-curator node, read its terminal line (judgment below), continue.
6. **After the last wave** — close the evidence gate, then report: `gk gate <graph>` (MERGE → continue; BLOCK → dispatch the owning node to write its missing evidence, re-stamp `gk run node --evidence`, re-gate). Then write `.graphkit/reports/<graph-name>.md` (per-node verdicts, gate verdict, overall verdict), then the `on_graph_complete` commands from the step-1 `gk graph waves --json` payload (`gk run end`, `gk memory consolidate`).

## Dispatch call shape

```
task({
  context: "<run-level background: graph name, evidence dir, prior verdicts>",
  tasks: [{ name: "<node-id>", agent: "gk-<node-id>",
            task: "<node.objective + upstream results + refs>" }]
})
```

Results arrive as async deliveries; full output at `agent://<name>`, transcript at `history://<name>`.

## Judgment you keep

- **CHALLENGE verdict** — a result's terminal `CHALLENGE: <node-id|plan> — <evidence>` line. Record the finding AND the adjudication in one ledger line: `gk run node <id> --status challenge --notes "disposition=accept|modify|reject|defer reason=…"`.
  - **accept** — evidence is decision-changing: re-dispatch the challenged node's owner with the finding appended under `## Challenged premise`; its `assumptions` are fair game to revise.
  - **modify** — premise partially holds: re-dispatch with the finding folded into the objective.
  - **reject** — noise or an equally-valid alternative: note it in the run report, continue.
  - **defer** — impact unclear: fire a read-only advisor (`gk_dispatch_agent`, `constraints: { no_write: true }`) to assess before the next dependent wave.
  - `CHALLENGE: plan` is never auto-adjudicated — suspend on a gate and let the user decide. Dissent is a right gated on evidence, never an obligation.
- **Gate suspension** — a node with `gate: {question, details}` suspends the run: surface the question and stop the wave loop. Approval → continue; rejection → record `skipped` (dependents cascade). Session died mid-suspension → `gk run end` the stale run, then `gk run resume`: skipped nodes stay skipped, never re-asked. One gate pause per node.
- **Worktree vs same-tree** — 2+ write nodes in a wave with overlapping scopes → worktree mode (merge-on-land is engine-owned) or sequence the colliders via `depend_on`. Decide BEFORE `gk run start`: `gk exec --worktree` starts its own run — it cannot attach to a ledger already opened interactively, and switching mid-run means `gk run end` + re-launch, forfeiting resume continuity. Same-tree only when file scopes partition cleanly. Escalate the moment you catch yourself drawing an ownership map; no git → sequenced same-tree.
- **Curator INJECTION** — the curator's final non-empty line must be exactly `INJECTION: <reminder>` or `INJECTION: null`; parse only that line. Non-null → prepend `[memory] <reminder>` to the next action wave's objectives. Null/missing/malformed → inject nothing, log a diagnostic, never block the action node.
- **budget_tokens** — advisory cap on upstream context injected into a dispatch (~chars/4). Over cap: compact (summarize per upstream node; keep verdicts, decisions, evidence keys), spill the full text to `.graphkit/artifacts/<node-id>-input.md`, pass the path. Never truncate below usefulness.
