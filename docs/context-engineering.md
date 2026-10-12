# Context Engineering

GraphKit's core claim, in the vocabulary the field converged on in 2025–2026: **every graph node is a fresh agent context with a compiled brief.** The DAG is a context-reset harness by construction — not a workaround bolted on after a single-loop agent's window degrades.

## The claim

Anthropic's March 2026 harness post describes the failure mode directly: models lose coherence as the window fills, and some exhibit "context anxiety" — wrapping up work prematurely as they approach a perceived context limit. Their remedy is a **context reset**: clear the window, start a fresh agent, and carry state forward through a structured handoff artifact. They found compaction (summarizing the same conversation in place) insufficient, because a shortened history is still a dirty window — the anxiety persists because the agent still believes it is near the end.

That is what `gk` already does. A single-loop agent compacts a dying window; a GraphKit run never has a dying window to compact. Each node dispatches a fresh subagent whose entire context is a compiled brief: `objective`, `refs`, injected upstream results, and declared constraints. State lives outside the context — in the evidence store, the run ledger, and the memory index — and re-enters the next context only through the mechanisms the graph author chose.

The reset is not free, and Anthropic names the cost: the handoff artifact must carry enough state for the next agent to pick up cleanly. In GraphKit terms, authoring a graph is deciding what that handoff is, per edge. `depend_on` decides which upstream results flow into the brief; `refs` decide which repo artifacts the agent pulls on demand; `evidence` decides what must land on disk to be proven at all.

## Mechanism map

Context engineering taxonomies (LangChain's write/select/compress/isolate, the Manus lessons, Anthropic's guidance) map onto concrete GraphKit machinery:

| Practice | Field guidance | GraphKit mechanism |
|---|---|---|
| **Write** — move state out of the window | Manus: use the filesystem as external memory; restorable compression means the raw artifact survives | Evidence artifacts (`gk evidence add`) are content-addressed sha256 files on disk — the system of record, not a summary. `budget_tokens` spills oversized upstream inputs to an artifact file rather than truncating them. The run ledger (`.graphkit/runs/<id>/`) is the append-only journal agents and `gk run resume` read back. |
| **Select** — pull in only what is relevant | Anthropic: smallest high-signal token set; just-in-time retrieval over pre-computed embeddings | `refs` carry `path` + `purpose` — pointers the agent resolves on demand, not inlined bodies. `gk memory recall` retrieves salience-ranked project memories (BM25 + Personalized PageRank); `topology_config.memory.recall_topk` caps the injection. `gk memory recall --explain` shows exactly why a memory ranked or was filtered, so selection is debuggable. |
| **Compress** — keep trajectories short | Manus: recitation beats summarization — repeat the goal, don't compress it away; keep wrong turns visible | A fresh `objective` per node is recitation at the graph level: the goal is restated per dispatch rather than summarized from history. Resume carries adjudicated state forward (`## Resume context`), and failed rounds stay in the round journal rather than being summarized away. |
| **Isolate** — split context across agents | Anthropic: subagents with curated tools; Manus: keep the main thread clean | The DAG itself. Each node is an isolated context; write nodes get git worktree isolation as well. Per-node `tools` allowlists curate the tool surface; `constraints` (`no_write`, `no_exec`, `tools_allowlist`) shrink capabilities where they're not needed; `role: supervisor` materializes a read-only peer that can inspect but not touch. |

## Memory is not truth

Two planes in GraphKit both look like "state," and conflating them is the most common authoring mistake:

- **`gk memory` is context.** A recall aid — salience-ranked, decayed, deduplicated, and *advisory*. It exists to put relevant hints in front of an agent. It can be wrong, stale, or superseded, and that's fine: nothing is proven by it.
- **The evidence store + run ledger is the system of record.** Content-addressed, freshness-tracked, hash-chained. A `gk gate` verdict is decided by evidence markers, not by anything a model remembers.

Rule of thumb: state an agent must *trust* goes through evidence and the ledger; state an agent should merely *be reminded of* goes through memory. Never let a gate depend on recall.

## Two operating modes

GraphKit is used in two distinct modes, and they want different context strategies:

- **Problem-solving** — a one-shot `gk run` / `gk exec` against a task-specific graph. Context is ephemeral: optimize the briefs (`objective`, `refs`, `depend_on`) so each node gets the smallest sufficient input.
- **Manufacturing** — authoring a reusable `graph.yaml` or `GraphTemplate` that will run many times. This is building a Digital FTE: the graph is the job description. Here the durable context assets matter — `constraints` as standing policy, `owns` as job scope, memory curation as institutional knowledge, `schedule` as the cadence.

Most research-fleet and audit graphs are manufacturing artifacts even when they feel one-shot — if a graph will be run again next month, author it for the second run, not the first.

## Practical guidance for graph authors

- **`refs` for authoritative artifacts.** Source files, specs, prior reports — anything the agent should read verbatim and that already lives in the repo or evidence store. Paths over bodies keeps briefs small and retrieval just-in-time.
- **`memory recall` for institutional knowledge.** Conventions, past decisions, recurring failure modes — things that help but aren't load-bearing. If a node would fail without it, it belongs in `refs` or the brief, not memory.
- **`objective` for the contract.** The node's goal, its output contract (which evidence keys it must produce), and its challengeable `assumptions`. High-signal only: an objective that restates the whole repo wastes the node's attention budget on the first tokens it reads.
- **`depend_on` for handoff, not completeness.** Depend on the nodes whose *results* this node needs. Every upstream result you inject is context the agent must filter; if it only needs an artifact, point at it with `refs`.
- **`budget_tokens` when upstream output is unbounded.** Advisory cap; oversized inputs compact and spill to an artifact file — the full text survives, restorable.
- **Constraints as negative context.** `no_write`, `no_exec`, `tools_allowlist`, and per-node `tools` remove options rather than instruct around them — the cheapest tokens are the capabilities the agent never had.

## Sources

- Anthropic, [*Effective context engineering for AI agents*](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Sep 2025) — smallest high-signal token set, just-in-time retrieval, context as finite resource.
- Anthropic, [*Effective harnesses for long-running agents*](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (Nov 2025) — multi-agent decomposition for long tasks.
- Anthropic, [*Harness design for long-running application development*](https://www.anthropic.com/engineering/harness-design-long-running-apps) (Mar 2026) — context anxiety; resets beat compaction; structured handoff artifacts.
- Manus, [*Context Engineering for AI Agents: Lessons from Building Manus*](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) (Jul 2025) — filesystem-as-context, recitation, restorable compression, keep wrong turns.
- LangChain, [*Context Engineering for Agents*](https://blog.langchain.com/context-engineering-for-agents/) — the write / select / compress / isolate taxonomy.
