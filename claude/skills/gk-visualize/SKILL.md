---
name: gk:visualize
description: Visualize a graph.yaml. Three modes: ASCII (in-session), SVG (visual export, opens in browser), Excalidraw (editable). Trigger: "visualize graph", "show diagram", "draw the graph", "what does the graph look like".
when_to_use: User wants to see the graph structure visually — topology, nodes, model tiers, depend_on edges, fan-out/fan-in.
user-invocable: true
disable-model-invocation: false
---

# gk visualize

## Purpose
Render a graph.yaml as a diagram. Modes:

- **Interactive** (default) — launches a private local viewer (browser). Live-updating graph canvas with path highlighting, persistent node drawer, search, filters, and live updates over Server-Sent Events. No public `gk graph view` command; the bundled `viewer/server.mjs` launcher starts the read-only server and prints the complete keyed URL. The interactive bundled viewer is the default for `/gk:visualize`.
- **ASCII** (in-session, instant) — pure CLI, no model, no rendering pipeline. Shows in terminal immediately. Explicit `/gk:visualize --ascii` mode.
- **SVG** (visual export, fast) — generates an SVG file, opens in browser. Explicit `/gk:visualize --svg` mode.
- **Excalidraw** (editable, slower) — generates an editable .excalidraw file. Only when user asks. Explicit `/gk:visualize --excalidraw`.

## Process

### Interactive (default)
Launch the bundled private viewer launcher — not a public CLI:

```bash
bun claude/viewer/server.mjs graph.yaml
# or cursor kit:
bun cursor/viewer/server.mjs graph.yaml
```

The launcher:
1. Starts a read-only server bound to `127.0.0.1` on port `4800` by default (env `GK_VIEWER_PORT` overrides; if that port is in use it falls back to the next free port, then to an ephemeral one) with a cryptographically random access key.
2. Prints the complete keyed URL: `GraphKit viewer: http://127.0.0.1:PORT/?key=...`
3. Does NOT auto-open a browser — surface the printed URL to the user and let them click. (Set `GK_VIEWER_OPEN=1` to restore auto-open; add `GK_VIEWER_BROWSER=chrome` to open in Chrome — `open -a "Google Chrome"` on macOS, `xdg-open` elsewhere.)

Lifecycle and safety:
- Key required for page, asset, and SSE requests.
- Live graph updates over Server-Sent Events; invalid saves show a stale-data banner and keep the last valid graph.
- Supports up to 250 nodes; larger graphs error explicitly.
- Idle timeout, explicit stop, or parent termination shuts the server down.

If startup fails, report the failure and fall back to the existing SVG mode (below).

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
- **Interactive**: keyed local URL (printed, not auto-opened)
- **ASCII**: stdout (instant)
- **SVG**: `.graphkit/diagrams/{name}.svg` — opens in browser
- **Excalidraw**: `.graphkit/diagrams/{name}.excalidraw` — editable in Excalidraw app
