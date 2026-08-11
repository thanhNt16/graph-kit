# Graph Templates and the Interactive Viewer

Two additive GraphKit capabilities built on the existing `gk` CLI:

- **Reusable graph templates** (`GraphTemplate v1`) — package a validated `graph.yaml` and let `/gk:init-graph` re-materialize it with new parameters.
- **Interactive viewer** — `/gk:visualize` opens a private, live-updating browser canvas with path highlighting and a persistent node-detail drawer. The ASCII, SVG, and Excalidraw modes remain unchanged and are one explicit flag away.

Everything below is grounded in the implemented CLI, skills, and viewer. The CLI stays deterministic — it validates and stores data. All interpretation, parameter extraction, and capability recommendation happens in the agent skill layer.

---

## Part I — Reusable templates

### What a template is

A template is a portable, parameterized `graph.yaml`. It is **data, not executable code** — a YAML `GraphTemplate v1` document that `/gk:init-graph` substitutes parameters into and writes out as an ordinary `graph.yaml`. Runtime commands never need to understand the template format; materialization produces a standard graph.

```yaml
apiVersion: graphkit.dev/v1
kind: GraphTemplate

metadata:
  name: security-audit
  description: Parallel security review with adversarial verification
  version: 1

parameters:
  target:
    description: Code or directory to audit
    required: true
  focus:
    description: Primary security concern
    default: general application security

recommendations:
  agents: [code-reviewer, software-architect]
  skills: [security-review]
  tools: [Read, Bash]
  capabilities:
    - purpose: Search code relationships
      candidates: [mcp:codebase-memory]
      optional: true

graph:
  topology: diamond
  nodes:
    reviewer:
      agent: code-reviewer
      model: opus
      objective: Audit {{target}} for {{focus}}.
```

### Storage and precedence

Templates live in two stores:

```text
<project>/.graphkit/templates/<name>.gk.yaml     # project-local
~/.graphkit/templates/<name>.gk.yaml             # user-global
```

**Project-local overrides user-global** for the same name. `gk template list` and `gk template show` resolve local before global and report both the resolved path and its origin. `gk template list` also reports `shadowed: true` when a global template is hidden by a local one. There is no registry and no network lookup.

Template names must match `^[a-z0-9]+(?:-[a-z0-9]+)*$` — lowercase words joined by single hyphens. This is enforced by the CLI and prevents path traversal while giving templates stable identifiers.

### Parameters

Each parameter has:

- `description` — required, non-empty.
- `required` — optional boolean, default `false`.
- `default` — optional scalar (string, number, boolean).

A parameter without a default must set `required: true`. A required parameter may not have a default.

References use exact `{{name}}` placeholders inside string values anywhere under `graph`. A value that is **solely one placeholder** (e.g. `model: {{tier}}`) may resolve to its scalar type; a placeholder **embedded in surrounding text** (e.g. `Audit {{target}}.`) always resolves to text.

`gk template pack` rejects a template when:

- a placeholder references an undeclared parameter,
- a declared parameter is never used,
- a required parameter has a default,
- a parameter name is not lower camel case or kebab-case,
- substitution would produce a non-string type where a placeholder is embedded in text.

### Recommendations

`recommendations` is **advisory metadata only**. It does not install, enable, or bind anything automatically. `agents`, `skills`, and `tools` are opaque names; `capabilities` describes a purpose plus ordered opaque candidates such as `mcp:codebase-memory` (`optional` defaults to `false`). `/gk:init-graph` recommends a capability only when `gk inventory` actually discovered it in the active installation — otherwise it labels it `install required` and never binds it. MCP stays represented through opaque strings; no graph schema change is required.

### CLI commands

```bash
# Pack a graph as a template
gk template pack graph.yaml --name security-audit           # project-local
gk template pack graph.yaml --name security-audit --global   # user-global
gk template pack graph.yaml --name security-audit --force    # overwrite existing

# Inspect
gk template list                          # name, desc, version, origin, shadowed
gk template list --json
gk template show security-audit           # local-before-global; unknown names get close matches
gk template show security-audit --json
```

`pack` validates the source graph through the normal schema + validation pipeline, validates the `GraphTemplate v1` contract and every parameter reference, then writes **atomically** — it writes a sibling temp file and renames it, so a partial write never clobbers an existing template. It refuses to overwrite an existing destination unless `--force` is given. Output reports name, origin, path, parameter count, and recommendation count.

### `/gk:template` walkthrough

Baby the skill packaging flow into a template:

1. **Validate the graph** — run `gk validate graph.yaml --json`. An invalid graph is never packaged.
2. **Identify variable values** — read the graph and spot repeated literals and task-specific nouns in metadata, inputs, objectives, constraints, refs, and outputs. Those are the values that change between runs.
3. **Propose the smallest useful parameter set** — do not parameterize structural values (topology, node IDs, dependency IDs, evidence keys, roles, loop limits) unless the user explicitly asks.
4. **Inventory installed capabilities** — `gk inventory --target claude --json`. Recommendations are derived only from capabilities actually installed (or explicitly marked `install required`).
5. **Show the proposed template (or a focused diff)** and ask the user to accept, edit, or reject — a hard approval gate.
6. **Invoke `gk template pack` only after approval.**

The skill never modifies the source graph.

---

## Part II — Inventory and smart graph initialization

### `gk inventory`

```bash
gk inventory --target claude --json
gk inventory --target cursor --json
```

Reports the installed agents, skills, tools, and MCP servers for the active target:

```json
{
  "target": "claude",
  "agents": [{ "name": "code-reviewer", "model": "opus" }],
  "skills": ["gk-recall", "gk-validate", "security-review"],
  "tools": ["Read", "Write", "Bash", "WebFetch"],
  "mcpServers": [
    { "name": "codebase-memory", "tools": ["search_graph", "get_code"] }
  ]
}
```

Sources: project-local kit agent/skill directories, user-global agent/skill directories, project and user MCP config files, and a versioned built-in list of host tool names. Project-local definitions override user-global by name. Agent frontmatter is parsed for a default model where present.

**Privacy guarantees** — the command emits only names:

- MCP output returns the server name and configured **tool names only**.
- It **never** returns server command arguments, URLs containing credentials, headers, environment values, tokens, or arbitrary configuration values.
- A malformed optional config file produces a warning while the rest of the inventory is preserved.
- **No network request, MCP connection, subprocess spawn, or capability installation occurs.** Inventory is purely a local file read.

### Smart `/gk:init-graph` walkthrough

```text
/gk:init-graph [--template <name>] [--task "<description>"]
```

1. **Resolve source.** `--template <name>`: named template → resolve project-local before global (`gk template show <name>`); named canonical topology / flow preset → retain existing `gk graph new` behavior; no template → compare the task to template descriptions and the topology routing rules, then offer the best two candidates when ambiguous.
2. **Inventory capabilities** — `gk inventory --target claude --json`.
3. **Collect parameters.** Infer values from `--task` where confidence is high; ask one focused question per unresolved required parameter; show defaults and permit edits.
4. **Analyze graph gaps.** Compare each node's objective, role, and template recommendations against installed agents, skills, tools, MCP servers, and model tiers. Suggest only concrete bindings supported by the inventory. Mark absent recommended capabilities `install required` — never bind them.
5. **Review changes.** Show proposed substitutions and per-node capability/model changes. The user accepts, edits, or rejects each.
6. **Materialize.** Substitute parameters and apply accepted changes into a standard graph document. Refuse to overwrite an existing `graph.yaml` unless the user explicitly approves replacement.
7. **Verify.** `gk validate graph.yaml --json`; fix only approved configuration errors; then suggest `/gk:visualize`.

**Model suggestions** are skill reasoning, not CLI policy. Every model change is shown for approval, and the skill never recommends an `opus`/`sonnet`/`haiku`/`fable` enum that isn't available.

---

## Part III — Interactive viewer

### Invocation and legacy modes

`/gk:visualize` **defaults to the interactive viewer.** Explicit legacy modes remain and are unchanged:

```text
/gk:visualize --ascii        # in-session ASCII, instant
/gk:visualize --svg          # .graphkit/diagrams/{name}.svg, opens in browser
/gk:visualize --excalidraw   # .graphkit/diagrams/{name}.excalidraw, editable
```

There is no new public `gk graph view` command. `gk graph ascii` and `gk graph svg` remain. The interactive viewer is launched by a **bundled launcher**, not a new CLI command:

```bash
bun claude/viewer/server.mjs graph.yaml
# cursor kit:
bun cursor/viewer/server.mjs graph.yaml
```

### Lifecycle and safety

The server:

- binds only to `127.0.0.1` on an available ephemeral port,
- generates a cryptographically random access key,
- requires that key on **every** request — HTML, asset, and SSE alike,
- prints the complete keyed URL `GraphKit viewer: http://127.0.0.1:PORT/?key=...` (still usable if browser launch fails),
- watches only the selected graph file,
- exits on parent/session termination, explicit stop, or four hours of inactivity,
- serves bundled local assets only and makes no external requests.

A strict Content Security Policy (self resources only), key-gating per request, text-escaped graph values, and file access restricted to the selected graph and bundled assets keep the viewer read-only and local-only. The browser cannot request arbitrary filesystem paths, and there is no graph-mutation endpoint.

### Interactions — canvas + persistent drawer

- **Canvas**. Selecting nothing leaves the graph full-width. Selecting a node opens a persistent right drawer and contracts the canvas **without resetting zoom or pan**. Closing the drawer expands the canvas and preserves the viewport. On narrow screens the drawer becomes a full-width overlay.
- **Hover / keyboard focus**. Emphasizes the node, its direct dependencies and dependents, and the connecting edges; dims unrelated nodes and edges. Does not open the drawer.
- **Click / Enter**. Locks the same path emphasis, opens the drawer, and updates a selected-state marker for assistive technology. **Click the background or press Escape** to clear selection and close the drawer.
- **Drawer links**. Dependency/dependent links inside the drawer select and center the referenced node.

### Controls

Toolbar controls: fit graph, zoom in/out, pointer/wheel zoom, pointer pan, and **search** over node ID, agent, objective, skill, and tool strings. Filters by **model**, **agent**, and **loop-enabled** state, plus a reset-filters control. Search results stay visible while unrelated nodes dim. Filtering hides nonmatching nodes only when doing so doesn't make remaining edges misleading; otherwise it dims them (labeled as emphasis rather than filtering).

### Drawer fields

The drawer renders all applicable node data: node ID, agent, model, role, objective, dependencies and dependents, skills, opaque tool/MCP strings, refs and purposes, constraints, loop state (enabled, stop condition, max rounds, exit condition), evidence keys, and eval configuration. Unknown future fields are ignored rather than rendered; all graph strings are inserted as text — never `innerHTML`.

### Accessibility

Nodes are keyboard-focusable in deterministic topological order, then node-ID order. Enter selects, Escape clears. Focus indicators meet WCAG 2.2 AA. The drawer is an accessible region that doesn't trap focus. Controls have accessible names independent of icons. Model color is never the only model indicator. `prefers-reduced-motion` disables transitions. Light and dark themes derive from complete token sets.

### Invalid graphs

- **Initial invalid graph** — the server still starts, shows a structured error screen (message, path, and line/column when available), and keeps watching for a correction.
- **Invalid save after a valid load** — the last valid graph stays visible behind a prominent **stale-data banner**; the validation findings go out over SSE, and the banner clears automatically on the next valid save.

### Scale ceiling

The first version supports up to **250 nodes**. Larger graphs receive an explicit error explaining the ceiling — the viewer never silently truncates. (Viewport virtualization or clustering is a future `ponytail` upgrade, only after real-world graphs exceed this.)

### Troubleshooting

- **Browser won't open** — the launcher prints the complete keyed URL; open it manually in any browser. The server keeps running regardless.
- **Graph not updating** — the server watches the one graph file with a debounce and falls back to mtime polling, so in-place saves are caught. Check that you saved the file the viewer was launched against.
- **Invalid graph** — an initial bad file shows the error screen; a bad save after a valid load shows the stale-data banner. Fix the file and save to recover; the banner clears itself.
- **Queue graphs > 250 nodes** — split into subgraphs or reduce node count; the viewer errors explicitly rather than truncating.
- **Excalidraw dependency missing** — Excalidraw mode needs `uv sync && uv run playwright install chromium` in the excalidraw-diagram skill's references dir; if unavailable, fall back to SVG or ASCII.

---

## Claude Code / Cursor parity

- The `gk` CLI is identical across targets — `template pack|list|show`, `inventory`, and `validate/graph` behave the same.
- Both kits bundle the **same viewer runtime**; the `claude/viewer/` and `cursor/viewer/` assets are byte-identical, and both launch identically (`bun claude/viewer/server.mjs` vs `bun cursor/viewer/server.mjs`).
- `gk-template`, `gk-init-graph`, and `gk-visualize` skills exist in both kits.
- **Execution parity differs only as before**: Claude Code runs the compile→run path (`/gk:run`) plus `/gk:execute`; Cursor has no Workflow tool, so `/gk:execute` is its sole execution path. Templates and the viewer behave the same in both hosts.
