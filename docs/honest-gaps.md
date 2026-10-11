# Honest Gaps

What GraphKit deliberately is not. Each boundary below is load-bearing: removing it would trade away the property that makes the rest of the system work.

## Not a GraphRAG / entity-indexing engine

`gk memory` is salience-ranked pattern recall (BM25 + Personalized PageRank over links) — a recall aid, not a knowledge graph. There is no entity extraction, no relation typing, no graph-structured retrieval over a world model. That's deliberate: memory is *context*, and the system of record is the evidence store. An entity index would invite agents to treat retrieval results as authoritative; in GraphKit, authority is only ever established by content-addressed evidence. See [context-engineering.md](./context-engineering.md) for the memory-vs-truth distinction.

## Not time-travel checkpoint replay

`gk run resume` is **forward-only**. It reconciles ledger state — which nodes have landed, which evidence is fresh, which dispatches were interrupted — and continues the run. It does not rewind the world to a checkpoint and re-execute from a snapshot. There is no snapshot of the working tree, the evidence store, or downstream effects to roll back to. This keeps resume deterministic: the ledger is a journal, not a time machine, and a resumed run's lineage is auditable (`gk run status` shows the `resumes:` ancestor chain).

## Not arbitrary shared-state reducers

Nodes do not write into a shared mutable store that later nodes reduce. They produce **evidence artifacts** — content-addressed, sha256-hashed, freshness-tracked, hash-chained into the run ledger (`gk run verify` re-checks both chain and artifact hashes). Handoff between agents happens through the compiled brief: `depend_on` results, `refs`, and injected context bounded by `budget_tokens`. A shared reducer would make runs non-replayable and unverifiable; artifacts keep every handoff inspectable after the fact.

## Not peer-to-peer agent messaging

Agents cannot message each other. There are no channels, no inboxes, no node-to-node calls at runtime. Nodes read only what the orchestrator-mediated brief carries — upstream results selected by `depend_on`, files pointed to by `refs`, recall hits. This is the product: **determinism requires that a run's information flow be fully declared in `graph.yaml`**. A message-passing swarm's behavior emerges at runtime; a GraphKit run's data flow is reviewable before dispatch, auditable after, and identical on replay. `role: supervisor` nodes get read-only tools for the same reason — oversight without a back channel.

## Not a work-queue broker

`gk queue` is file-based intake, not a message broker. There is no daemon, no push delivery, no retry/backoff machinery, no at-least-once semantics — a task is a YAML file with a `state` field, and claiming is a locked read-modify-write, not a subscription. The orchestrator polls `claim` and decides what to do with the result; `gk` never dispatches work on its own. That's the boundary: a broker would hide scheduling policy (ordering, retries, routing) inside runtime machinery, whereas the factory needs every queue decision — what was added, what was claimed by whom, what failed and blocked whom — to stay inspectable bytes on disk that `gk queue status` can render and `git` can diff.

## Not a model runner

`gk` never calls an LLM. It compiles, validates, plans, journals, gates, and reports — execution is dispatched to your host coding agent (Claude Code, Pi, Cursor, OpenCode, Codex). No token billing, no model lock-in, no hidden inference in the CLI itself. The boundary keeps `gk` deterministic and cheap to trust: anything the CLI emits is reproducible bytes, and every model decision happens inside a dispatched node where `constraints` apply.

---

If your use case needs entity indexing, checkpoint rewind, shared state, agent chatter, or built-in inference, GraphKit is the wrong tool — those are different products, and bolting them on would dissolve the guarantees above.
