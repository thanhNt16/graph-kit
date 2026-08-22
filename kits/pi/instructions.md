# GraphKit

## agent-binding

Agent names in graph.yaml must resolve to agent fragments under `.pi/agents/`.

- Every `agent` value in a node must match a fragment file `.pi/agents/<agent>.md`.
- If a bound agent doesn't exist, fail validation with: "Agent 'X' not found. Available: Y, Z."
- `tools`, `skills`, and `refs` are additive — they extend the agent fragment's capabilities, not replace them. Node `tools` map to `constraints.tools_allowlist` on `gk_dispatch_agent`; write-free nodes get `constraints.no_write = true`.

## graph-authority

gk owns graph state. The wave structure from graph.yaml is the execution plan.

- Never improvise edges or skip nodes at runtime.
- Never modify topology after planning — recompile/re-plan if needed.
- Execution is deterministic: same graph.yaml → same wave order.
- If a node fails (`gk_dispatch_agent` returns ok:false), stop the graph — do not retry outside the declared loop config.

## topology-routing

Decision tree for suggesting topology in the gk-init-graph skill.

1. User says "audit" or "review" or "verify" → suggest **diamond** (fan-out workers + verification)
2. User says "triage" or "route" or "categorize" → suggest **classify-and-act**
3. User says "research" or "discover" or "find" → suggest **loop-until-done**
4. User says "brainstorm" or "ideas" or "naming" → suggest **generate-and-filter** (keep best K)
5. User says "compare" or "rank" or "evaluate options" → suggest **tournament**
6. If ambiguous, show top 2 options with brief descriptions and let user pick.
