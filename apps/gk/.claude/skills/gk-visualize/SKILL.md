---
name: gk-visualize
description: Render graph.yaml as an Excalidraw diagram with node colors by model tier and dependency arrows.
when_to_use: Use when the user asks to visualize a graph, render a diagram from graph.yaml, or see the graph topology visually.
user-invocable: true
disable-model-invocation: false
---

# gk visualize

## Purpose
Render graph.yaml as an Excalidraw diagram.

## Process

1. Read graph.yaml.
2. Parse nodes and depend_on edges.
3. Invoke the excalidraw-diagram skill to generate the diagram.
4. Color nodes by model tier (opus=purple, sonnet=blue, haiku=green, fable=amber).
5. Draw depend_on arrows between nodes.
6. Mark nodes with internal loops with a circular indicator.
7. Draw subgraph boundaries as dashed rectangles for composed templates.
8. Write output to `.graphkit/diagrams/{name}.excalidraw`.
9. Auto-open in browser (render via excalidraw skill pipeline).

## Color Reference
See `references/graph-palette.md` for the full GraphKit color palette.

## Output
- `.graphkit/diagrams/{name}.excalidraw` — editable in Excalidraw
- `.graphkit/diagrams/{name}.png` — rendered preview (optional)
