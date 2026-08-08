---
name: gk:visualize
description: Visualize a graph.yaml. Two modes: instant ASCII diagram (default) or Excalidraw (visual, slower). Trigger: "visualize graph", "show diagram", "draw the graph", "what does the graph look like".
when_to_use: User wants to see the graph structure visually — topology, nodes, model tiers, depend_on edges, fan-out/fan-in.
user-invocable: true
disable-model-invocation: false
---

# gk visualize

## Purpose
Render a graph.yaml as a diagram. Two modes:

- **ASCII** (default, instant) — pure CLI, no model, no rendering pipeline. Shows in terminal immediately.
- **Excalidraw** (visual, slower) — generates an editable .excalidraw file, requires Python + Playwright.

## Process

### ASCII (default — always try this first)

```bash
gk graph ascii graph.yaml
```

This is instant — pure code output. Shows nodes with model-tier icons (🟣opus 🔵sonnet 🟢haiku), depend_on arrows, fan-out/fan-in labels, loop indicators (↻), and evidence keys. Perfect for quick iteration during graph design.

Show the output directly to the user. Done.

### Excalidraw (only if the user explicitly asks for a visual/shareable diagram)

If the user says "excalidraw", "export", "shareable", "browser", or "I want to edit it":

1. Read graph.yaml.
2. Invoke the `excalidraw-diagram` skill to generate the diagram.
3. Color nodes by model tier (opus=purple, sonnet=blue, haiku=green, fable=amber).
4. Draw depend_on arrows between nodes.
5. Mark nodes with internal loops with a circular indicator.
6. Draw subgraph boundaries for composed templates.
7. Write to `.graphkit/diagrams/{name}.excalidraw`.

Note: Excalidraw mode requires `uv sync && uv run playwright install chromium` in the excalidraw-diagram skill's references dir. If unavailable, fall back to ASCII and tell the user.

## Output
- **ASCII**: stdout (instant)
- **Excalidraw**: `.graphkit/diagrams/{name}.excalidraw` — editable in Excalidraw app
