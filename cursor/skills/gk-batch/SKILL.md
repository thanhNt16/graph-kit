---
name: gk-batch
description: Execute a graph.yaml as parallel worktree-isolated background agents — Claude Code's /batch technique, with the graph as the decomposition. Each write-node runs in its own git worktree, tests, and lands a branch; waves stay barriers. Trigger: "batch the graph", "run graph in worktrees", "/gk:batch".
when_to_use: A graph's waves contain 2+ nodes that write files and their scopes overlap or are hard to partition — worktree isolation replaces hand-drawn ownership maps. Also for large mechanical sweeps expressed as a graph.
user-invocable: true
disable-model-invocation: true
---

# gk batch

## Purpose

Run a graph.yaml with the `/batch` technique: the graph IS the decomposition (no LLM
plan-mode decomposition needed — `depend_on` waves are deterministic), and each
write-capable node in a wave runs as a **background subagent in an isolated git
worktree**. Workers can't collide, so node ownership maps become unnecessary.

Requires: a git repository, Claude Code (Agent tool with worktree isolation).
Cursor hosts have no worktree-isolated subagents — see Fallback.

## When to use (vs /gk:execute)

| | /gk:execute | /gk:batch |
|---|---|---|
| Parallel nodes share files | needs a hand-crafted ownership map | worktree per node — collisions impossible |
| Merge strategy | none (single tree) | sequential branch merge, tests between |
| Overhead | none | worktree setup + merge per node |
| Best for | read-heavy waves, ≤3 writers with clean scopes | write-heavy fan-out, overlapping scopes, mechanical sweeps |

Default to `/gk:execute`; escalate to `/gk:batch` when a wave has 2+ writers whose
file scopes overlap or would need an ownership map.

## Process

### Step 1: Get the waves

```bash
gk graph waves graph.yaml --json
```

### Step 2: Per wave, dispatch in ONE message

For each node in the wave, spawn an Agent call — all wave nodes in a single message
so they run in parallel:

- **Write-capable nodes** (executors, fixers — anything that edits files):
  `isolation: "worktree"`, `run_in_background: true`.
- **Read-only nodes** (research, review): plain background dispatch — a worktree
  buys nothing and costs setup.

Each prompt must be FULLY SELF-CONTAINED (background workers cannot ask the user):

1. The node's `objective` verbatim, plus agent identity (from `.claude/agents/<agent>.md`)
2. `refs` (path + purpose) and `constraints`
3. Upstream results: point at the dependency nodes' evidence files (`.graphkit/evidence/<dep>.md`)
4. Repo conventions the worker needs (test command, lint, no-new-deps rule)
5. An e2e/self-check recipe: the exact commands proving the node's acceptance checks
   (workers decide verification up front — decide it for them here)
6. Landing instructions (see Step 3) — commit to the worktree branch, message format

### Step 3: Collect and merge (the wave barrier)

When all agents in a wave finish (wait on the notifications — never assume):

1. List each worker's branch (`git worktree list`).
2. Merge sequentially INTO THE MAIN TREE, in node order: `git merge --no-ff <branch>`
   — after each merge run the test command (`bun test` here; use the repo's gate).
   A merge that breaks the gate: stop, report, fix before merging the next.
3. Resolve conflicts in favor of the more specific change; if two workers edited the
   same lines, that's a plan smell — the graph should have sequenced them via `depend_on`.
4. Clean up worktrees (`git worktree remove`), keep branches until the whole graph passes.

### Step 4: Feed the next wave

Synthesizer/fan-in nodes receive: each merged worker's summary + evidence file paths.
Repeat until the last wave; then write `.graphkit/reports/<graph-name>.md` as usual.

## Rules

- **Graph authority unchanged**: topology, depend_on ordering, and loops come from
  graph.yaml — worktrees are transport-level isolation only. Never add/remove nodes.
- **One PR/branch per node is the ceiling, not the floor**: for graphs whose fan-in
  synthesizer rewrites everything, let workers commit to branches and merge — only
  open actual PRs when the user asked for them.
- **Merge is the barrier**: a wave is done when merged AND the gate is green, not
  when agents return.
- Workers cannot ask the user — if a node's task is ambiguous, resolve it BEFORE
  dispatch (the orchestrator decides, per graph authority).

## Fallback (Cursor / no worktree support)

Same-tree execution with a strict function/file ownership map declared per node
(the `/gk:execute` pattern): the plan phase must partition files so parallel nodes
never touch the same file. If partitioning fails, sequence the nodes via `depend_on`
and re-validate.

## Output

- Per-node: branch name + merge status + evidence file
- Final: `.graphkit/reports/<graph-name>.md` (waves, merges, gate results, verdict)
