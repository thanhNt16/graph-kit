<!-- graphkit:start -->
## GraphKit

### agent-binding

Agent names in graph.yaml must resolve to agent definitions under `.codex/agents/`.

#### Validation

- Every `agent` value in a node must match a definition in `.codex/agents/` (by its `name` field).
- If a bound agent doesn't exist, fail validation with: "Agent 'X' not found. Available: Y, Z."
- The agent's `model` field overrides the agent's default from its TOML.
- `tools`, `skills`, and `refs` are additive — they extend the agent's default capabilities, not replace them.

### graph-authority

gk owns graph state. The compiled workflow is the execution plan.

#### Inviolable Rules

- Never improvise edges or skip nodes at runtime.
- Never modify topology after compilation — recompile if needed.
- The workflow script is deterministic: same graph.yaml → same .workflow.js.
- If a node fails, the workflow handles it (null filter, error boundary) — do not retry outside the declared loop config.

### topology-routing

Decision tree for suggesting topology in the gk-init-graph skill.

#### Rules

1. User says "audit" or "review" or "verify" → suggest **diamond** (fan-out workers + verification)
2. User says "triage" or "route" or "categorize" → suggest **classify-and-act**
3. User says "research" or "discover" or "find" → suggest **loop-until-done**
4. User says "brainstorm" or "ideas" or "naming" → suggest **generate-and-filter** (keep best K)
5. User says "compare" or "rank" or "evaluate options" → suggest **tournament**
6. If ambiguous, show top 2 options with brief descriptions and let user pick.

### Runtime guards (no hooks on this host)

Codex has no hook/plugin enforcement layer, so these behaviors are explicit instructions you MUST follow:

- **Never edit files under `.graphkit/state/` directly** — run state mutations only through `gk` CLI commands (`gk memory`, `gk graph`). Direct edits corrupt leases and decay bookkeeping.
- **Never edit `.graphkit/evidence/**` while a run is active** (`.graphkit/runs/.active` exists) — evidence files are workflow-owned during a run.
- **Never hand-edit `.graphkit/evidence/.index` or `.graphkit/memory/.index`** — they are derived; regenerate via `gk memory touch` / `gk memory trace`.
- After writing OKF memory files by hand, run `gk memory trace` once so decay scores and the dirty flag reflect the new reality.
<!-- graphkit:end -->
