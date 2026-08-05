---
name: graphkit-task-execute-verify-planner
description: Run the task-execute-verify GraphKit workflow through Claude Code
when_to_use: Use when executing the task-execute-verify workflow.
user-invocable: true
---

## Authority protocol

- Start by calling `gk workflow start` only when no run exists.
- At every step call `gk workflow next`; GraphKit chooses all edges and limits.
- Submit structured output only with `gk workflow submit` for the returned contract.
- Execute deterministic work only with `gk workflow execute`; never replace it with a guessed command.
- Never infer edges, skip nodes, raise limits, or invent evidence.
- For parallel dispatch, spawn only the leased work items and never exceed the returned concurrency ceiling. Use subagents or an Agent Team only for those leases; submit each result with its lease.
- Required evidence keys: summary.

## Planning protocol

- Reflect the loaded task and objective back as a one-step context plan without inventing requirements.
- Keep the plan concrete and one-step; GraphKit routes the next node after your submission.
