<!-- graphkit:start -->
## GraphKit

### agent-binding

Agent names in graph.yaml must resolve to agent fragments under `.codex/agents/`.

- Every `agent` value in a node must match `.codex/agents/<agent>.md`.
- If a bound agent does not exist, fail validation with: "Agent 'X' not found. Available: Y, Z."
- `tools`, `skills`, and `refs` extend the agent fragment's capabilities — node `tools`/`skills`/`constraints` travel with every dispatch. On pi, `gk graph agents` additionally bakes them into materialized agents under `.omp/agents` for native task dispatch; `gk_dispatch_agent` (fallback path) takes them as `constraints.tools_allowlist` / `constraints.no_write`.

### graph-authority

gk owns graph state. The wave structure from graph.yaml is the execution plan.

- Never improvise edges or skip nodes at runtime.
- Never modify topology after planning; re-plan instead.
- Execution is deterministic: same graph.yaml, same wave order.
- If a node dispatch fails (task spawn nonzero exit / `gk_dispatch_agent` ok:false), stop the graph. Do not retry outside declared loop/retry config.
- A node's output may end with `CHALLENGE: <node-id|plan> — <evidence>`: evidence-gated dissent against an upstream premise or the plan. The orchestrator records `--status challenge`, adjudicates, and re-dispatches the owner with the finding — challenge is a right gated on concrete evidence, never an obligation.
- Mid-flight human steering relays via `hub send <node-id>`; a direction change is recorded in the run report AND the evidence dir, so downstream nodes see it through shared state.

### topology-routing

1. "audit", "review", or "verify": suggest **diamond**.
2. "triage", "route", or "categorize": suggest **classify-and-act**.
3. "research", "discover", or "find": suggest **loop-until-done**.
4. "brainstorm", "ideas", or "naming": suggest **generate-and-filter**.
5. "compare", "rank", or "evaluate options": suggest **tournament**.
6. Ambiguous: show the top two options and ask.
### Runtime guards (no hooks on this host)

Codex has no hook/plugin enforcement layer, so these behaviors are explicit instructions you MUST follow:

- **Never edit files under `.graphkit/state/` directly** — run state mutations only through `gk` CLI commands (`gk memory`, `gk graph`). Direct edits corrupt leases and decay bookkeeping.
- **Never edit `.graphkit/evidence/**` while a run is active** (`.graphkit/runs/.active` exists) — evidence files are workflow-owned during a run.
- **Never hand-edit `.graphkit/evidence/.index` or `.graphkit/memory/.index`** — they are derived; regenerate via `gk memory touch` / `gk memory trace`.
- After writing OKF memory files by hand, run `gk memory trace` once so decay scores and the dirty flag reflect the new reality.
<!-- graphkit:end -->
