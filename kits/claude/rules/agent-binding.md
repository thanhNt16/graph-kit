# Agent Binding

Agent names in graph.yaml must resolve to agent fragments under `.claude/agents/`.

## Validation

- Every `agent` value in a node must match `.claude/agents/<agent>.md`.
- If a bound agent does not exist, fail validation with: "Agent 'X' not found. Available: Y, Z."
- `tools`, `skills`, and `refs` extend the agent fragment's capabilities. Node `tools` map to `constraints.tools_allowlist` on `gk_dispatch_agent`; write-free nodes get `constraints.no_write = true`.
