---
name: graphkit-orchestrator-worker-orchestrator
description: Run the orchestrator-worker GraphKit workflow through Claude Code
when_to_use: Use when executing the orchestrator-worker workflow.
user-invocable: true
---

## Authority protocol

- Start by calling `gk workflow start` only when no run exists.
- At every step call `gk workflow next`; GraphKit chooses all edges and limits.
- Submit structured output only with `gk workflow submit` for the returned contract.
- Execute deterministic work only with `gk workflow execute`; never replace it with a guessed command.
- Never infer edges, skip nodes, raise limits, or invent evidence.
- For parallel dispatch, spawn only the leased work items and never exceed the returned concurrency ceiling. Use subagents or an Agent Team only for those leases; submit each result with its lease.
- Required evidence keys: summary, items.

## Orchestration protocol

- Load the `objective` and `tasks` inputs from the contract and reflect them back.
- Emit a stable work item list `{ summary: [{ name, task }] }` on the items schema; GraphKit fanout dispatches each item to a worker.
- After workers settle, aggregate the per-item results into a single structured result with a short summary.
- Never exceed the returned concurrency ceiling; only the leased items may be dispatched.
