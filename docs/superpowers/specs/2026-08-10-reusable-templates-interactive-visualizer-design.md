# Reusable Graph Templates and Interactive Visualizer Design

**Date:** 2026-08-10
**Status:** Proposed
**Scope:** GraphKit CLI and Claude Code/Cursor kits

## Goal

Add two complementary GraphKit capabilities:

1. Package an existing `graph.yaml` as a portable, parameterized workflow template that `/gk:init-graph` can reuse and adapt through user-approved capability suggestions.
2. Make `/gk:visualize` open a local, live-updating interactive graph viewer with path highlighting and a persistent node-detail drawer.

Both capabilities remain additive. Existing graph scaffolding, validation, compilation, direct execution, ASCII output, SVG export, and Excalidraw output continue unchanged.

## Design Principles

- Keep the CLI deterministic. Agent skills own interpretation and recommendation.
- Store graph templates as readable YAML data, never executable bundles.
- Recommend only capabilities discovered in the active Claude Code or Cursor installation.
- Never expose MCP configuration values, environment variables, credentials, or tokens.
- Require user approval before applying agent-generated graph changes.
- Preserve GraphKit graph authority: templates materialize a graph; they do not modify topology at runtime.
- Keep the viewer read-only, local-only, dependency-free beyond packages already installed.

## Architecture

### Deterministic CLI layer

The CLI gains two command groups:

```text
gk template pack|list|show
gk inventory
```

These commands parse, validate, store, resolve, and report data. They do not call an LLM or infer which capability a graph should use.

### Agent skill layer

Claude Code and Cursor receive matching skills:

- `/gk:template` assists with parameter extraction and recommendation metadata, shows the proposed result, then invokes `gk template pack` after approval.
- `/gk:init-graph` resolves packaged templates, inventories installed capabilities, collects parameter values, proposes graph changes, obtains approval, and materializes `graph.yaml`.
- `/gk:visualize` launches the bundled local viewer, opens it in a browser, and falls back to SVG when the live viewer cannot start.

### Viewer layer

Each kit bundles the same viewer runtime. A small Node server reads `graph.yaml`, validates and normalizes it, watches for changes, and sends updates to a static browser application over Server-Sent Events (SSE).

## Part I: Reusable Graph Templates

### Storage and resolution

Templates use two stores:

```text
<project>/.graphkit/templates/<name>.gk.yaml
~/.graphkit/templates/<name>.gk.yaml
```

Project-local templates override user-global templates with the same name. Listing reports both the resolved template and its origin. No registry or network lookup is included.

Template names must match:

```text
^[a-z0-9]+(?:-[a-z0-9]+)*$
```

This prevents path traversal and gives templates stable CLI identifiers.

### GraphTemplate v1 contract

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

The `graph` value contains the existing graph document fields below its current envelope. Materialization produces an ordinary `graph.yaml`; runtime commands do not need to understand `GraphTemplate`.

### Parameter contract

Each parameter has:

- `description`: required, non-empty string.
- `required`: optional boolean; defaults to `false`.
- `default`: optional scalar string, number, or boolean.

A parameter without a default must set `required: true`. Parameter references use exact `{{name}}` placeholders inside string values anywhere under `graph`.

Packaging fails when:

- A placeholder references an undeclared parameter.
- A declared parameter is unused.
- A required parameter has a default.
- A parameter name is not lower camel case or kebab-case.
- Substitution would produce a non-string type where the placeholder is embedded in surrounding text.

A value consisting solely of one placeholder may resolve to its scalar type. An embedded placeholder always resolves to text.

### Recommendation contract

Recommendations are advisory metadata. They do not install, enable, or bind capabilities automatically.

- `agents`, `skills`, and `tools` contain opaque names.
- `capabilities` describes a purpose and ordered opaque candidates, such as `mcp:codebase-memory`.
- `optional` defaults to `false`.

MCP remains represented through opaque tool/capability strings. No graph schema change is required.

### CLI commands

#### Pack

```bash
gk template pack graph.yaml --name security-audit
gk template pack graph.yaml --name security-audit --global
gk template pack graph.yaml --name security-audit --force
```

Behavior:

1. Resolve and validate the source graph with the existing graph schema and validation pipeline.
2. Read optional prepared parameter and recommendation metadata supplied by `/gk:template` through a temporary complete `GraphTemplate` input file or explicit CLI input option.
3. Validate `GraphTemplate` v1 and all parameter references.
4. Write atomically to the selected store.
5. Refuse an existing destination unless `--force` is present.
6. Return the name, origin, path, parameter count, and recommendation count in text or JSON form.

The implementation must not overwrite a destination through a partial write. It writes a sibling temporary file, then renames it.

#### List

```bash
gk template list
gk template list --json
```

Reports name, description, version, origin, and whether a global template is shadowed by a local template.

#### Show

```bash
gk template show security-audit
gk template show security-audit --json
```

Resolves local before global. Unknown names report close matches and available names.

### `/gk:template` packaging flow

1. Read and validate the current graph.
2. Identify repeated literals and task-specific nouns in metadata, inputs, objectives, constraints, refs, and outputs.
3. Propose the smallest useful parameter set. Do not parameterize structural values such as topology, node IDs, dependency IDs, evidence keys, roles, or loop limits unless the user explicitly requests it.
4. Inventory installed capabilities.
5. Derive recommendation metadata only from capabilities actually installed or explicitly marked `install required`.
6. Show the complete proposed template or focused diff.
7. Ask the user to accept, edit, or reject the proposal.
8. Invoke `gk template pack` only after approval.

The skill does not modify the source graph.

## Part II: Inventory and Smart Graph Initialization

### Inventory command

```bash
gk inventory --target claude --json
gk inventory --target cursor --json
```

Output contract:

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

Inventory sources:

- Project-local kit agent and skill directories.
- User-global agent and skill directories when supported by the host.
- Project and user MCP configuration files recognized by Claude Code or Cursor.
- Built-in host tool names from a versioned GraphKit list.

Rules:

- Project-local definitions override user-global definitions by name.
- Parse agent frontmatter for default model where present.
- MCP output includes server and configured tool names only.
- Never return server command arguments, URLs containing credentials, headers, environment values, tokens, or arbitrary configuration values.
- Malformed optional config files produce warnings while preserving successfully discovered inventory.
- No network request, MCP connection, subprocess spawn, or capability installation occurs.

### Smart `/gk:init-graph` flow

```text
/gk:init-graph [--template <name>] [--task "<description>"]
```

1. **Resolve source**
   - If `--template` names a packaged template, resolve project-local before global.
   - If it names a canonical topology or flow preset, retain existing `gk graph new` behavior.
   - Without `--template`, compare the task to packaged template descriptions and current topology routing rules, then offer the best two candidates when ambiguous.
2. **Inventory capabilities**
   - Invoke `gk inventory` for the active target.
3. **Collect parameters**
   - Infer values from `--task` where confidence is high.
   - Ask one focused question for each unresolved required parameter.
   - Show defaults and permit edits.
4. **Analyze graph gaps**
   - Compare each node's objective, role, and recommendations against installed agents, skills, tools, MCP servers, and model tiers.
   - Suggest only concrete bindings supported by inventory.
   - Mark absent recommended capabilities as `install required`; do not bind them.
5. **Review changes**
   - Show proposed substitutions and capability/model changes per node.
   - Let the user accept, edit, or reject changes.
6. **Materialize**
   - Substitute parameters and apply accepted changes.
   - Produce a standard graph document.
   - Refuse an existing `graph.yaml` unless the user explicitly approves replacement.
7. **Verify**
   - Run `gk validate graph.yaml --json`.
   - Fix only approved configuration errors.
   - Suggest `/gk:visualize` after validation.

### Model suggestions

Model recommendations remain skill reasoning, not CLI policy. The skill considers:

- Existing node model.
- Agent frontmatter default.
- Objective complexity and risk.
- Fan-out cost.
- Whether the node performs final synthesis or adversarial verification.

A model change is always shown for approval. The skill never recommends an unavailable model enum.

## Part III: Interactive Visualization

### Invocation and compatibility

`/gk:visualize` defaults to the interactive viewer.

Explicit modes remain:

```text
/gk:visualize --ascii
/gk:visualize --svg
/gk:visualize --excalidraw
```

No new public `gk graph view` command is introduced. Existing `gk graph ascii` and `gk graph svg` commands remain unchanged.

### Server lifecycle

The visualization skill starts the bundled viewer server with the graph path.

Server requirements:

- Bind only to `127.0.0.1` by default.
- Select an available ephemeral port.
- Generate a cryptographically random access key.
- Require the key for HTML, asset, and SSE requests.
- Print the complete keyed URL if browser opening fails.
- Watch only the selected graph file.
- Exit on parent/session termination, explicit stop, or four hours of inactivity.
- Serve bundled local assets only; make no external requests.

The skill opens the URL in the default browser. If server startup or browser launch fails, it reports the failure and offers or automatically produces the existing SVG mode where safe.

### Data flow

```text
graph.yaml
  → parse + GraphSchema validation
  → normalize nodes, edges, reverse edges, levels, display metadata
  → initial HTTP payload
  → browser graph layout

file change
  → debounce
  → parse + validate
  → SSE graph update or structured error
  → preserve viewport and selected node where possible
```

The server keeps the last valid normalized graph in memory. An invalid save does not replace it.

### Layout

The accepted interaction model is **Canvas + persistent drawer**.

- The graph canvas occupies the full content area when no node is selected.
- Selecting a node opens a persistent right drawer and contracts the canvas without resetting zoom or pan.
- Closing the drawer expands the canvas and preserves the viewport.
- The drawer uses a responsive width with a practical maximum; on narrow screens it becomes a full-width overlay because side-by-side inspection would be unreadable.

The layout engine reuses `@dagrejs/dagre`. The browser receives normalized node and edge data; it does not parse YAML.

### Node and edge interactions

#### Hover

Hovering or keyboard-focusing a node:

- Emphasizes the node.
- Emphasizes direct dependencies, direct dependents, and connecting edges.
- Dims unrelated nodes and edges.
- Does not open the drawer.

#### Selection

Clicking a node or pressing Enter:

- Locks the same path emphasis.
- Opens the drawer.
- Updates a selected-state marker for assistive technology.

Clicking the background or pressing Escape clears selection and closes the drawer.

Dependency/dependent links in the drawer select and center the referenced node.

### Canvas controls

- Fit graph.
- Zoom in and out.
- Pointer/wheel zoom.
- Pointer pan.
- Search node ID, agent, objective, skill, and tool strings.
- Filter by model, agent, and loop-enabled state.
- Reset filters.

Search results remain visible while unrelated nodes dim. Filters hide nonmatching nodes only when doing so does not make the remaining edges misleading; otherwise they dim them and label the mode as emphasis rather than filtering.

### Drawer fields

The drawer renders all applicable node data:

- Node ID.
- Agent/subagent.
- Model.
- Role.
- Objective.
- Dependencies and dependents.
- Skills.
- Opaque tool and MCP strings.
- References and purposes.
- Constraints.
- Loop enabled state, stop condition, maximum rounds, and exit condition.
- Evidence keys produced.
- Evaluation configuration.

Unknown future fields are ignored rather than rendered as raw untrusted HTML. All graph strings are inserted as text, never with `innerHTML`.

### Accessibility

- Every node is keyboard-focusable in deterministic topological order, then node ID order.
- Enter selects; Escape clears.
- Focus indicators meet WCAG 2.2 AA contrast.
- Drawer uses an accessible region label and does not trap focus.
- Controls have names independent of icons.
- Model colors are never the only model indicator.
- `prefers-reduced-motion` disables transitions.
- Light and dark themes derive from complete token sets.

### Viewer security

- Localhost binding by default.
- Random URL key checked on every request.
- Strict Content Security Policy: local self resources only; no inline remote execution, object, frame, or network destinations.
- No remote fonts, scripts, styles, telemetry, fetches, or images.
- Graph values are text-escaped.
- File access is restricted to the selected graph and bundled viewer assets.
- The browser cannot request arbitrary filesystem paths.
- Viewer is read-only and exposes no graph mutation endpoint.

### Invalid graph behavior

Initial invalid graph:

- Serve a structured error screen with message, path, and line/column when available.
- Continue watching for correction.

Invalid graph after a valid load:

- Keep the last valid graph visible.
- Show a prominent stale-data error banner.
- Send the validation findings through SSE.
- Automatically clear the banner after the next valid save.

### Scale ceiling

The first version supports up to 250 nodes. Larger graphs receive an explicit error explaining the ceiling; the viewer does not silently truncate.

`ponytail:` add viewport virtualization or graph clustering only after observed real-world graphs exceed this ceiling.

## File Boundaries

```text
src/cli/commands/template.ts
  pack/list/show command registration and atomic storage operations

src/cli/commands/inventory.ts
  target-aware, secret-safe installed capability inventory

src/schemas/template.schema.ts
  GraphTemplate v1 and placeholder validation

src/viewer/normalize.ts
  graph-to-view-model conversion shared by server tests

claude/skills/gk-template/SKILL.md
cursor/skills/gk-template/SKILL.md
  agent-assisted packaging flows

claude/skills/gk-init-graph/SKILL.md
cursor/skills/gk-init-graph/SKILL.md
  packaged-template resolution and capability suggestion flow

claude/skills/gk-visualize/SKILL.md
cursor/skills/gk-visualize/SKILL.md
  viewer lifecycle and explicit legacy modes

claude/viewer/
cursor/viewer/
  matching server and static browser assets
```

Shared source should be authored once where the build/package process can copy it into both target kits. Generated target copies must have parity tests to prevent drift. No new runtime dependency is added.

## Testing Strategy

### Template schema and commands

- Accept a minimal valid GraphTemplate v1.
- Reject unknown, unused, malformed, and type-invalid parameter references.
- Validate the embedded graph using the existing graph schema and validation pipeline.
- Resolve local before global.
- Report shadowed global templates.
- Reject unsafe names and path traversal.
- Refuse overwrite without `--force`.
- Prove atomic writes leave an existing template intact after simulated failure.
- Return equivalent text and JSON data.

### Inventory

- Discover project and user agents/skills for Claude and Cursor.
- Apply local override precedence.
- Parse agent default models.
- Discover MCP server/tool names from supported configuration fixtures.
- Exclude command arguments, URLs with credentials, headers, environment values, and tokens.
- Preserve partial inventory with warnings for malformed optional files.
- Confirm no subprocess or network path is used.

### Initialization integration

- Pack graph, list/show template, materialize with parameters, then validate output.
- Resolve project-local template over a same-named global template.
- Ask for every unresolved required parameter.
- Use defaults correctly.
- Suggest only installed capabilities.
- Label absent recommendations `install required` without binding.
- Refuse graph overwrite without explicit approval.
- Preserve canonical topology scaffolding behavior when no packaged template is selected.

### Viewer unit and integration tests

- Normalize every supported node field and forward/reverse edge.
- Bind to localhost and require a valid random key.
- Reject missing/invalid keys for page, asset, and SSE requests.
- Serve an initial valid graph.
- Emit a graph update after a valid file change.
- Retain the last valid graph and emit findings after an invalid save.
- Recover after a subsequent valid save.
- Reject graphs above 250 nodes.
- Stop on idle timeout and parent termination.

### Browser behavior tests

- Hover emphasizes selected paths and dims unrelated nodes.
- Click opens persistent drawer and contracts canvas without resetting viewport.
- Background click and Escape close drawer.
- Dependency links select and center target nodes.
- Search covers IDs, agents, objectives, skills, and tools.
- Model, agent, and loop filters work.
- Nodes are keyboard reachable and Enter-selectable.
- Reduced-motion mode removes transitions.
- Invalid-save banner appears and clears on recovery.
- Graph-provided markup renders as text.

### Regression suite

- Existing `graph new`, `validate`, `compile`, `waves`, `execute`, ASCII, SVG, and Excalidraw behavior remains unchanged.
- Claude and Cursor kit installation includes the new skill and viewer assets.
- Claude and Cursor generated viewer assets are byte-equivalent where expected.
- `bun test` and `bun run ci:local` pass.

## Documentation

Update user-facing documentation with:

- Template creation, storage, precedence, and parameter examples.
- `/gk:template` and smart `/gk:init-graph` walkthrough.
- Inventory behavior and privacy guarantees.
- Interactive viewer controls and explicit legacy modes.
- Troubleshooting browser launch, file watching, invalid graphs, and large-graph limits.
- Claude Code and Cursor parity notes.

## Out of Scope

- Bundling or installing agent, skill, hook, MCP, or executable files inside templates.
- Remote template registries or package publishing.
- LLM calls from the CLI.
- Editing graph data in the viewer.
- Remote viewer hosting, collaboration, or telemetry.
- A public `gk graph view` command.
- Structured MCP fields in `graph.yaml`.
- Virtualized rendering, clustering, or graphs above 250 nodes.
