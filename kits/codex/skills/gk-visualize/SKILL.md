---
name: gk-visualize
description: Visualize a graph.yaml. Four modes: archify HTML (default, shareable artifact), ASCII (in-session), SVG (fast export), Excalidraw (editable). Trigger: "visualize graph", "show diagram", "draw the graph", "what does the graph look like".
when_to_use: User wants to see the graph structure visually — topology, nodes, model tiers, depend_on edges, fan-out/fan-in.
user-invocable: true
disable-model-invocation: false
---

# gk visualize

## Purpose
Render a graph.yaml as a diagram. Modes:

- **Archify HTML** (default) — you author a typed JSON IR from the graph, archify compiles it to a single self-contained HTML file with pan/zoom, search, and guided views. Shareable, attachable to a PR, opens with no server. Default for `gk-visualize`.
- **ASCII** (in-session, instant) — pure CLI, no model, no rendering pipeline. Shows in terminal immediately. Explicit `gk-visualize --ascii` mode.
- **SVG** (visual export, fast) — generates an SVG file, opens in browser. Explicit `gk-visualize --svg` mode. Also the fallback when archify is unavailable.
- **Excalidraw** (editable, slower) — generates an editable .excalidraw file. Only when user asks. Explicit `gk-visualize --excalidraw`.

## Process

### Archify HTML (default)

**Step 1 — locate archify.** Probe in order; first hit wins:

```bash
for d in ./node_modules/archify ~/.codex/skills/archify ~/.agents/skills/archify; do
  [ -f "$d/bin/archify.mjs" ] && echo "$d" && break
done
```

Not found → **ask the user once** before installing: "archify isn't installed. Install it with `npx -y skills add tt-a1i/archify -g`?" On approval run that command, then re-probe. On decline, no network, or a failing `node <archify>/bin/archify.mjs doctor` → fall back to the SVG mode below and tell the user why.

**Step 2 — read the graph structure.**

```bash
gk graph waves graph.yaml
```

This emits the topological wave structure: each wave is a set of nodes that can run in parallel, with full node objects (`agent`, `model`, `objective`, `tools`, `depend_on`, `loop`, `evidence`). Wave index becomes the diagram column — do not recompute the ordering yourself.

**Step 3 — pick the diagram type.**

| Signal in graph.yaml | archify type |
|---|---|
| any node has `loop:` | `lifecycle` |
| topology is `memory-augmented`, or subgraphs / composed templates present | `architecture` |
| otherwise (plain DAG) | `workflow` |

**Step 4 — author the IR.** Read `references/archify-ir.md` — it holds the mapping rules and a complete worked example. Edit that example rather than composing from nothing. Write the candidate to `.graphkit/diagrams/{name}.archify.json`.

**Step 5 — validate after every edit.** Never skip this between edits.

```bash
node <archify>/bin/archify.mjs validate <type> .graphkit/diagrams/{name}.archify.json --quality showcase --json
```

Non-zero exit is never success. A showcase pass means all 9 artifact checks, 0 composition errors, 0 warnings; a 4-check receipt is basic validation only, not acceptance. Fix and re-validate. Cap at 5 cycles — if it still will not pass, deliver at default quality and report the remaining warnings rather than thrashing.

**Step 6 — deliver once, when validation is clean.**

```bash
node <archify>/bin/archify.mjs deliver <type> .graphkit/diagrams/{name}.archify.json .graphkit/diagrams/{name}.html --quality showcase --json
```

Print the output path. Do not auto-open a browser — surface the path and let the user click.

### ASCII (in-session, instant — explicit mode)
```bash
gk graph ascii graph.yaml
```

This is instant — pure code output. Shows nodes with model-tier icons (🟣opus 🔵sonnet 🟢haiku), depend_on arrows, fan-out/fan-in labels, loop indicators (↻), and evidence keys. Perfect for quick iteration during graph design.

Show the output directly to the user. Done.

### SVG (visual export — fast, explicit mode)
```bash
gk graph svg graph.yaml
```
→ writes `.graphkit/diagrams/{name}.svg`, opens in browser

Renders at 1.2ms. Color nodes by model tier. Perfect for a fast look or when archify is unavailable.

### Excalidraw (editable diagram — only if user asks)
Only use the `excalidraw-diagram` skill when the user explicitly says "excalidraw" or "editable".

1. Read graph.yaml.
2. Invoke the `excalidraw-diagram` skill to generate the diagram.
3. Color nodes by model tier (opus=purple, sonnet=blue, haiku=green, fable=amber).
4. Draw depend_on arrows between nodes.
5. Mark nodes with internal loops with a circular indicator.
6. Draw subgraph boundaries for composed templates.
7. Write to `.graphkit/diagrams/{name}.excalidraw`.

Note: Excalidraw mode requires `uv sync && uv run playwright install chromium` in the excalidraw-diagram skill's references dir. If unavailable, fall back to SVG or ASCII and tell the user.

## Output
- **Archify HTML**: `.graphkit/diagrams/{name}.html` (self-contained) + `.graphkit/diagrams/{name}.archify.json` (editable IR source)
- **ASCII**: stdout (instant)
- **SVG**: `.graphkit/diagrams/{name}.svg` — opens in browser
- **Excalidraw**: `.graphkit/diagrams/{name}.excalidraw` — editable in Excalidraw app
