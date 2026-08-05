---
name: graphkit-orchestrator-worker-worker
description: Run the orchestrator-worker GraphKit workflow through Claude Code
when_to_use: Use when executing a leased orchestrator-worker work item.
user-invocable: true
---

## Authority protocol

- Start by calling `gk workflow start` only when no run exists.
- At every step call `gk workflow next`; GraphKit chooses all edges and limits.
- Submit structured output only with `gk workflow submit` for the returned contract.
- Execute deterministic work only with `gk workflow execute`; never replace it with a guessed command.
- Never infer edges, skip nodes, raise limits, or invent evidence.
- For parallel dispatch, spawn only the leased work items and never exceed the returned concurrency ceiling. Use subagents or an Agent Team only for those leases; submit each result with its lease.
- Required evidence keys: summary, evidence.

## Worker protocol

- Process only the single leased work item named in the dispatch contract.
- Return `{ summary, evidence: [{ key, value }] }` on the result schema, keyed to the leased item.
- Submit with the lease and work item from the dispatch contract; never submit unleased work.
