# Agent Binding

Agent names in graph.yaml must resolve to agent fragments under `.claude/agents/`.

## Validation

- Every `agent` value in a node must match `.claude/agents/<agent>.md`.
- If a bound agent does not exist, fail validation with: "Agent 'X' not found. Available: Y, Z."
- `tools`, `skills`, and `refs` extend the agent fragment's capabilities. `gk graph agents` bakes node `tools`/`skills`/`constraints` into materialized `.claude/agents/gk-<node>.md` files for native task dispatch; `gk_dispatch_agent` (fallback path) takes them as `constraints.tools_allowlist` / `constraints.no_write`.
