<!-- graphkit:start -->
## GraphKit

### agent-binding

Agent names in graph.yaml must resolve to agent fragments under `.omp/agents/`.

- Every `agent` value in a node must match `.omp/agents/<agent>.md`.
- If a bound agent does not exist, fail validation with: "Agent 'X' not found. Available: Y, Z."
- `tools`, `skills`, and `refs` extend the agent fragment's capabilities. Node `tools` map to `constraints.tools_allowlist` on `gk_dispatch_agent`; write-free nodes get `constraints.no_write = true`.

### graph-authority

gk owns graph state. The wave structure from graph.yaml is the execution plan.

- Never improvise edges or skip nodes at runtime.
- Never modify topology after planning; re-plan instead.
- Execution is deterministic: same graph.yaml, same wave order.
- If `gk_dispatch_agent` returns `ok:false`, stop the graph. Do not retry outside declared loop config.

### topology-routing

1. "audit", "review", or "verify": suggest **diamond**.
2. "triage", "route", or "categorize": suggest **classify-and-act**.
3. "research", "discover", or "find": suggest **loop-until-done**.
4. "brainstorm", "ideas", or "naming": suggest **generate-and-filter**.
5. "compare", "rank", or "evaluate options": suggest **tournament**.
6. Ambiguous: show the top two options and ask.
<!-- graphkit:end -->
