# Graph Templates and Diagrams

Two additive GraphKit capabilities built on the existing `gk` CLI:

- **Reusable graph templates** (`GraphTemplate v1`) — package a validated `graph.yaml` and let `/gk:init-graph` re-materialize it with new parameters.
- **Archify diagrams** — `/gk:visualize` renders the graph as a self-contained HTML artifact. The ASCII, SVG, and Excalidraw modes remain unchanged and are one explicit flag away.

Everything below is grounded in the implemented CLI and skills. The CLI stays deterministic — it validates and stores data. All interpretation, parameter extraction, and capability recommendation happens in the agent skill layer.

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

# Inspect templates (resolves project > global > gallery)
gk template list                          # name, desc, version, origin, shadowed
gk template list --json
gk template show security-audit           # resolves project > global > gallery; unknown names get close matches
gk template show security-audit --json

# Materialize a template into an immutable session graph
gk template materialize audit-pr --params '{"task":"audit auth flow"}'
gk template materialize audit-pr --params '{"task":"audit auth flow"}' --use  # also flips .graphkit/active
```

Templates resolve across 3 stores in order: `<project>/.graphkit/templates/` (`project`) ⇒ `~/.graphkit/templates/` (`global`) ⇒ bundled gallery (`gallery`). `gk template list` reports an `origin` field (`project` | `global` | `gallery`) and flags `shadowed: true` when a higher-precedence template hides a broader one.

`pack` validates the source graph through the schema + validation pipeline, verifies the `GraphTemplate v1` contract and all parameter references, then writes **atomically** (via sibling temp file + rename).

`materialize` substitutes parameters into the template, runs schema validation, and saves an immutable session graph under `.graphkit/graphs/<YYYY-MM-DD>-<slug>.yaml` (same-date collisions append `-2`, `-3`). When `--use` is passed, it activates the new graph by writing its id to `.graphkit/active`. Session graphs can be inspected and switched with `gk graph list`, `gk graph switch <id>`, and `gk graph show [id]`.

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

## Part III — Archify diagrams

### Invocation and modes

`/gk:visualize` **defaults to an archify-rendered HTML diagram.** The other modes remain and are unchanged:

```text
/gk:visualize --ascii        # in-session ASCII, instant
/gk:visualize --svg          # .graphkit/diagrams/{name}.svg, opens in browser
/gk:visualize --excalidraw   # .graphkit/diagrams/{name}.excalidraw, editable
```

There is no new `gk` subcommand. `gk graph ascii`, `gk graph svg`, and `gk graph waves` are unchanged; the default mode is entirely skill-layer work on top of them.

### Dependency and fallback

[archify](https://github.com/tt-a1i/archify) (MIT) is a Node diagram renderer with an agent-facing contract. The skill probes for `bin/archify.mjs` under `./node_modules/archify` and the host skill roots. If it isn't installed, the skill **asks once** before running:

```bash
npx -y skills add tt-a1i/archify -g
```

A declined install, no network, or a failing `archify doctor` falls back to the SVG mode and says why. archify is never a hard dependency of `gk`.

### How the diagram is authored

1. `gk graph waves graph.yaml` supplies the topological wave structure with full node objects. Wave index becomes the diagram column — the skill never recomputes ordering.
2. The diagram type is routed from graph shape: any node with `loop:` → `lifecycle`; memory-augmented topology or composed subgraphs → `architecture`; otherwise `workflow`.
3. Model tier becomes the lane (opus, sonnet, haiku, fable), node ID the label, agent the sublabel, `depend_on` the edges.
4. `references/archify-ir.md` in the kit carries the mapping tables and a complete worked IR example; the model edits that example rather than composing from nothing.

### Validate before deliver

```bash
archify validate <type> candidate.json --quality showcase --json
archify deliver  <type> candidate.json output.html --quality showcase --json
```

`validate` runs after **every** IR edit; a non-zero exit is never success. A showcase pass means all 9 artifact checks with 0 composition errors and 0 warnings — a 4-check receipt is basic validation, not acceptance. The loop is capped at 5 validate cycles; beyond that the skill delivers at default quality and reports the remaining warnings rather than thrashing.

### Output

- `.graphkit/diagrams/{name}.html` — self-contained artifact with pan/zoom, search, and guided views. No server, no key, no live updates; open it directly or attach it to a PR.
- `.graphkit/diagrams/{name}.archify.json` — the IR source, kept so the diagram can be hand-tuned and re-delivered.

The path is printed rather than auto-opened.

### Troubleshooting

- **archify not found** — approve the `npx -y skills add tt-a1i/archify -g` prompt, or install it yourself and re-run. Declining is fine; you get SVG.
- **Validation won't reach showcase** — the JSON output names the failing check. Common causes are overlapping columns (trust `gk graph waves`), lanes with no nodes, and edges referencing IDs that aren't in `nodes`.
- **Diagram is too dense** — large graphs read better as `architecture` with subgraph groups, or split into per-subgraph diagrams.
- **Excalidraw dependency missing** — Excalidraw mode needs `uv sync && uv run playwright install chromium` in the excalidraw-diagram skill's references dir; if unavailable, fall back to SVG or ASCII.

---

## Cross-host parity

- The `gk` CLI is identical across targets — `template pack|list|show`, `inventory`, and `validate/graph` behave the same.
- `gk-template`, `gk-init-graph`, and `gk-visualize` skills exist in all five kits, and the `gk-visualize` bodies differ only in skill name and invocation prefix.
- **Execution parity differs only as before**: Claude Code runs the compile→run path (`/gk:run`) plus `/gk:execute`; other hosts have no Workflow tool, so `/gk:execute` is their sole execution path. Templates and diagrams behave the same everywhere.
