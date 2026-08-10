---
name: gk:visualize
description: Visualize a graph.yaml. Three modes: ASCII (in-session), SVG (visual export, opens in browser), Excalidraw (editable). Trigger: "visualize graph", "show diagram", "draw the graph", "what does the graph look like".
when_to_use: User wants to see the graph structure visually — topology, nodes, model tiers, depend_on edges, fan-out/fan-in.
user-invocable: true
disable-model-invocation: false
---

# gk visualize

## Purpose
Render a graph.yaml as a diagram. Three modes:

- **ASCII** (in-session, instant) — pure CLI, no model, no rendering pipeline. Shows in terminal immediately. Default for terminal use.
- **SVG** (visual export, fast) — generates an SVG file, opens in browser. 1.2ms render. Default for visual export.
- **Excalidraw** (editable, slower) — generates an editable .excalidraw file. Only when user asks.

## Process

### ASCII (in-session, instant — default for terminal)
```bash
gk graph ascii graph.yaml
```

This is instant — pure code output. Shows nodes with model-tier icons (🟣opus 🔵sonnet 🟢haiku), depend_on arrows, fan-out/fan-in labels, loop indicators (↻), and evidence keys. Perfect for quick iteration during graph design.

Show the output directly to the user. Done.

### SVG (visual export — fast, opens in browser)
```bash
gk graph svg graph.yaml
```
→ writes `.graphkit/diagrams/{name}.svg`, opens in browser

Renders at 1.2ms. Color nodes by model tier. Perfect for sharing, screenshots, or quick visual review without Excalidraw overhead.

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
- **ASCII**: stdout (instant)
- **SVG**: `.graphkit/diagrams/{name}.svg` — opens in browser
- **Excalidraw**: `.graphkit/diagrams/{name}.excalidraw` — editable in Excalidraw app
