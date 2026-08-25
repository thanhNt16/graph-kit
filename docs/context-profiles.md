# Context profiles

A **context profile** is a named per-node binding convention — `tools` + `skills` on a node — that fixes *what a node may read and through which surface*, instead of leaving context acquisition to each agent's improvisation. Profiles are pure graph.yaml data: no new schema fields, no runtime changes. The profile name lives in the node's `objective` (and this doc); the binding itself is the two existing arrays.

## Symbol-first profile

Binds code-analysis nodes to symbol-level navigation (codebase-memory MCP, optionally Serena) so downstream nodes receive `qualified_name` + `file_path:start-end` anchors instead of pasted file bodies. This is the kit's L3 discipline (bounded context) applied to code: the map is small and stable; readers pull only the symbols they need.

```yaml
nodes:
  mapper:
    agent: software-architect
    model: sonnet
    objective: |
      Context profile: symbol-first. Map the subsystem to its load-bearing
      symbols via the codebase-memory MCP tools. Emit anchors only — never
      inline file bodies.
    tools: [Read, Grep, Glob]
    skills: [codebase-memory]   # add serena for LSP-backed edits/refs
    depend_on: []
```

- `skills: [codebase-memory]` — the checked-in pattern (`graph.yaml` runs it on research nodes). The skill instructs the node to query the indexed call graph rather than grep-and-read everything.
- `tools` stays read-only and host-native; the MCP surface is reached through the skill's tool calls, not by widening the allowlist.

## Value

- Downstream prompts carry file:line anchors (bytes), not file bodies (kilobytes) — wave 3+ no longer compounds every ancestor's full output.
- Anchors are verifiable: a reviewer can open `file_path:start-end` and check the claim.

## Failure when MCP is absent — explicit, not silent

The profile is fail-closed on purpose:

1. **Preflight**: run `gk inventory --target <target>` — if `codebase-memory` is not listed under `mcpServers`, the host has no MCP server configured and every symbol-first node will fail.
2. **At execution**: the node objective must state the degradation contract (see the example): with no reachable codebase-memory server, the node reports failure immediately — it does **not** fall back to unbounded whole-file reads. A silent fallback would reintroduce exactly the context blow-up the profile exists to prevent.
3. **CLI bridge reality**: `gk graph index|search|ask|trace|query` exit 1 with `CBM_UNAVAILABLE` unless `CBM_CMD`/`CBM_ARGS` point at a local codebase-memory-mcp build (the npm package is unpublished today — see "CBM boundary" in the README). File-based `gk memory recall` is unaffected.

Validation does not check MCP availability — `gk validate` passes any `skills:` list because gk never spawns anything. The guarantee above is behavioral: put it in the objective, as the runnable example does.

## When not to use

- Markdown/docs-only repositories: `search_graph` over `.md` indexes returns shell entries with no searchable content (measured; see the gk-recall skill).
- Nodes that only read their declared `refs` — plain per-node binding already bounds them.

## Runnable example

[`examples/symbol-first.yaml`](../examples/symbol-first.yaml) validates with:

```bash
gk validate examples/symbol-first.yaml
```
