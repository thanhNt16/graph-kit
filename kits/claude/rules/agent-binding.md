# Agent Binding

Agent names in graph.yaml must resolve to files in `claude/agents/`.

## Validation

- Every `agent` value in a node must match a filename in `claude/agents/` (without extension).
- If a bound agent doesn't exist, fail validation with: "Agent 'X' not found. Available: Y, Z."
- The agent's `model` field overrides the agent's default from frontmatter.
- `tools`, `skills`, and `refs` are additive — they extend the agent's default capabilities, not replace them.
