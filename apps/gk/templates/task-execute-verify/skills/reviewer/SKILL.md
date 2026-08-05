---
name: graphkit-task-execute-verify-reviewer
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
- Required evidence keys: summary, verdict, approval, evidence.

## Evaluation protocol

- Judge only the returned implementation evidence; never re-implement the plan step.
- Return `{ summary, verdict: passed|retry|blocked, approval: bool, evidence: [{ key, value }] }` exactly on the evaluation schema.
- Emit `verdict: retry` only when a fixable failure is identified; set `approval: true` only when a human gate is genuinely required.
