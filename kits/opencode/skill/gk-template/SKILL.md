---
name: gk-template
description: Package an existing graph.yaml as a reusable, parameterized workflow template (GraphTemplate v1) that /gk:init-graph can adapt. Use when the user wants to package/save a graph as a template, reuse a graph across tasks, or parameterize a workflow. Trigger: "package graph", "save as template", "gk template pack", "make a template".
when_to_use: User wants to turn an existing graph.yaml into a reusable template for /gk:init-graph, parameterize a graph's variable inputs, or save a workflow for reuse.
user-invocable: true
disable-model-invocation: false
---

# gk template

## Purpose
Package an existing, validated `graph.yaml` as a portable, parameterized **GraphTemplate v1** that `/gk:init-graph` can materialize and adapt. The CLI stores and validates the template; this skill owns the interpretation, parameter extraction, and recommendation metadata — and never modifies the source graph.

Storage (via `gk template pack`):
```text
<project>/.graphkit/templates/<name>.gk.yaml     # project-local (overrides global)
~/.graphkit/templates/<name>.gk.yaml             # user-global
```

## Guardrails
- **Never modify the source graph.** Packaging is read-only over `graph.yaml`.
- **Smallest useful parameter set.** Do not parameterize structural values — topology, node IDs, dependency IDs, evidence keys, roles, loop limits — unless the user explicitly requests it.
- **Recommend only installed capabilities.** Derive recommendation metadata solely from agents/skills/tools/MCP servers actually discovered in the active OpenCode installation, or explicitly marked `install required`.
- **Never expose secrets.** No MCP config values, env vars, credentials, or tokens in any recommendation.

## Process

1. **Validate the current graph.** Run:
   ```bash
   gk validate graph.yaml --json
   ```
   If findings exist, stop and surface them. Do not package an invalid graph.

2. **Identify variable values.** Read `graph.yaml`. Look for repeated literals and task-specific nouns in metadata, inputs, objectives, constraints, refs, and outputs — the values that change between runs of the same workflow shape.

3. **Propose the smallest useful parameter set.** For each candidate, decide:
   - Is it a repeated literal or task input? → parameterize.
   - Is it a structural value (topology, node ID, dependency ID, evidence key, role, loop limit)? → do NOT parameterize unless the user explicitly asks.

4. **Inventory installed capabilities.** Run:
   ```bash
   gk inventory --target claude --json
   ```
   Use the returned agents, skills, tools, and MCP servers to populate `recommendations`.

5. **Derive recommendation metadata** only from installed capabilities (or ones the user explicitly marks `install required`). Never invent a capability.

6. **Show the complete proposed template or a focused diff.** Present the full `GraphTemplate v1` document (or a clear before/after diff) to the user.

7. **Ask the user to accept, edit, or reject** the proposal. This is a hard approval gate.

8. **Invoke `gk template pack` only after approval.** Write the prepared input to a temporary GraphTemplate file and pack it:
   ```bash
   gk template pack graph.yaml --name <name>            # project-local
   gk template pack graph.yaml --name <name> --global     # user-global
   gk template pack graph.yaml --name <name> --force      # overwrite existing
   ```
   Report the returned name, origin, path, parameter count, and recommendation count.

## Parameter contract
Each parameter in `parameters` has:
- `description` — required, non-empty.
- `required` — optional boolean, default `false`.
- `default` — optional scalar (string, number, boolean).

A parameter without a default must set `required: true`. References use exact `{{name}}` placeholders inside string values anywhere under `graph`. A value consisting solely of one placeholder may resolve to its scalar type; an embedded placeholder always resolves to text.

The CLI rejects packaging when a placeholder is undeclared, a declared parameter is unused, a required parameter has a default, a name is not lower camel-case or kebab-case, or substitution would produce a non-string type where a placeholder is embedded in surrounding text.

## Output
Writes a `GraphTemplate v1` file to the selected template store. Returns name, origin, path, parameter count, and recommendation count. The skill does not modify the source graph.
