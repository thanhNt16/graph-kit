# Graph Viewer Redesign

**Date:** 2026-08-11  
**Status:** Approved

## Objective

Redesign `gk:visualize` as an editorial, dark-first workflow diagram. The viewer must reveal workflow composition—phases, fan-out, fan-in, and loops—while preserving existing live updates, search, filters, keyboard navigation, pan/zoom, security boundaries, and output parity.

Visual direction follows Image #3 and the principles from [`cathrynlavery/diagram-design`](https://github.com/cathrynlavery/diagram-design): low density, one focal accent, strong hierarchy, semantic design tokens, restrained decoration, and accessible contrast.

## Constraints

- Preserve CSP `script-src 'self'`; do not add inline scripts or remote assets.
- Insert graph data through text nodes or `textContent`, never `innerHTML`.
- Keep generated `claude/viewer` and `cursor/viewer` assets byte-identical.
- Keep pure state and graph rules in `src/viewer/view.ts`, independent of the DOM.
- Keep dagre as the bundled IIFE layout engine.
- Support the existing 250-node normalization limit.
- Preserve the last valid graph when a live update is invalid.
- Respect `prefers-reduced-motion`.
- Use model text labels as well as color; color must not be the sole indicator.

## Design Principles

1. **Composition before detail.** Phase lanes and edge flow communicate topology before node metadata.
2. **One focal accent.** Blue is reserved for the active node and its local path. Model colors remain narrow rails or badges.
3. **Density target: 4/10.** Reduce decoration and let spacing, hierarchy, and contrast carry the diagram.
4. **Stable canvas.** Interaction changes classes and attributes rather than destroying and rebuilding the SVG.
5. **Progressive detail.** Canvas cards stay concise; the existing drawer contains full node data.

## Visual System

The viewer is dark-first. Semantic tokens replace component-specific color decisions:

| Token | Dark value | Purpose |
|---|---:|---|
| `--bg` | `#0d1117` | canvas paper |
| `--surface` | `#161b22` | node and drawer surface |
| `--surface-2` | `#21262d` | controls and secondary surface |
| `--ink` | `#e6edf3` | primary text |
| `--muted` | `#7d8590` | metadata and labels |
| `--hairline` | `#30363d` | borders, lanes, inactive edges |
| `--accent` | `#58a6ff` | selection and emphasized path |
| `--tier-opus` | `#bc8cff` | Opus rail and text badge |
| `--tier-sonnet` | `#58a6ff` | Sonnet rail and text badge |
| `--tier-haiku` | `#3fb950` | Haiku rail and text badge |
| `--tier-fable` | `#f0883e` | Fable rail and text badge |

A complete light palette remains available through the theme control. Explicit light and dark selections override the operating-system preference.

## Layout and Composition

### Phase lanes

`normalize.ts` already computes each node's `level` using the graph's longest path. The renderer will use that value to draw horizontal phase lanes behind nodes. Each lane contains:

- an alternating low-contrast fill bounded by hairline dividers;
- a compact `Phase N` label in muted text;
- nodes whose normalized `level` equals `N`.

Dagre remains responsible for node placement and routing inputs. The lane layer visualizes normalized levels; it does not introduce a second layout algorithm or mutate topology. A toolbar control may toggle lane visibility without recomputing layout.

### Node cards

Each node card remains compact but gains clearer hierarchy:

- 3px model-tier rail along the left edge;
- node ID in monospaced primary text;
- agent and model in muted secondary text;
- loop and evaluation glyphs when applicable;
- textual model label so the rail color is supplementary;
- selected-state accent ring and slight visual lift.

Full objective, dependencies, dependents, tools, skills, references, constraints, loop configuration, evidence, and evaluation details remain in the drawer.

### Edges

Edges use smooth SVG paths and a shared SVG marker rather than separate hand-computed arrowhead paths. Edge presentation has three states:

1. inactive: hairline stroke;
2. related: normal contrast;
3. emphasized: accent stroke, increased width, restrained glow.

Direction remains explicit through arrowheads. Edge geometry must not obscure node cards or lane labels.

## Rendering Architecture

### Render layers

The SVG viewport contains stable layers in this order:

1. `lane-layer` — phase backgrounds and labels;
2. `edge-layer` — dependency paths;
3. `node-layer` — interactive node groups.

A single `<defs>` section owns the arrow marker and any restrained filter primitives.

### Keyed updates

The current `draw()` removes and recreates the viewport for every search, filter, or graph update. The redesigned renderer separates work:

- **Topology update:** compute dagre layout; reconcile lane, edge, and node elements by stable keys; add missing elements; remove obsolete elements; update changed attributes.
- **View-state update:** update classes and ARIA/data attributes only. Do not reconstruct SVG elements.
- **Viewport update:** update only the viewport transform.

Stable keys:

- node: normalized node ID;
- edge: source ID plus target ID;
- lane: normalized level.

DOM indexes (`Map<string, Element>`) avoid repeated full-tree queries during emphasis updates.

## Interaction

### Hover and keyboard focus

Hovering or focusing a node emphasizes its one-hop neighborhood using the existing pure `emphasisIds` policy. Connected nodes and edges become prominent; unrelated elements dim to 25% opacity.

### Selection

Click or Enter selects a node, opens the drawer, and locks emphasis to that selection. Selecting the same node again, pressing Escape, clicking the canvas background, or closing the drawer clears selection. Navigation from dependency/dependent badges selects and centers the target node.

### Search and filters

Search, model, agent, and loop filters preserve graph context. Non-matches remain visible but dim and become non-interactive; they are never removed, because removal would make retained edges misleading. Reset clears all search and filter state without recomputing topology.

### Pan and zoom

Existing mouse pan, wheel zoom, keyboard zoom, double-click fit, and Fit button behavior remain. Live updates preserve viewport and valid selection. Initial load alone fits the graph automatically.

### Keyboard order

Tab order follows normalized `level`, then normalized `order`, then node ID. Each node exposes a useful ARIA label containing ID, agent, and model.

## Motion

Motion clarifies state rather than decorating it:

- first paint: nodes fade and rise 6px over 240ms, staggered by phase at 30ms;
- emphasis: opacity, stroke, fill, and transform transition over 160ms;
- selection: ring and lift transition over 160ms;
- live topology updates: added nodes enter; retained nodes do not replay entrance motion.

Under `prefers-reduced-motion: reduce`, entrance and transition animations are disabled. No continuous or looping ambient animation is introduced.

## Data Flow

1. Server emits a normalized graph through initial HTTP fetch or SSE.
2. `applyGraph` retains valid selection and viewport state.
3. Layout computes node positions and edge points from normalized graph data.
4. Reconciliation updates keyed SVG elements and phase lanes.
5. Header, filters, drawer, and keyboard order refresh from the same graph.
6. View-state changes update indexed element classes without rerunning layout.
7. Invalid live data displays the stale banner while retaining the last valid rendering.

## Error Handling

Existing behavior remains:

- invalid initial graph: show the error screen and source path;
- invalid subsequent graph: keep the last valid graph and show a stale banner;
- missing selected node after update: clear selection and close the drawer;
- SSE transport error: allow native EventSource retry behavior;
- absent or empty graph: use safe default bounds and preserve usable controls.

Renderer reconciliation must tolerate missing dagre edge points by skipping malformed paths rather than failing the entire viewer.

## Accessibility

- Maintain keyboard selection, clearing, centering, and zoom controls.
- Preserve visible focus rings at WCAG AA contrast.
- Pair every tier color with a model text label.
- Keep controls labeled and node groups exposed as keyboard-operable buttons.
- Keep text legible at default fit; drawer remains available for full detail.
- Respect reduced motion.
- Keep selection and emphasis distinguishable without relying only on color through stroke width, opacity, and ring treatment.

## Testing

### Pure unit tests

Extend `view.ts` tests only for new pure policies, such as keyed reconciliation helpers if extracted. Preserve existing search, filtering, selection retention, fitting, and neighborhood emphasis coverage.

### Viewer integration tests

Update the fake DOM only for APIs genuinely used by the renderer. Verify:

- phase lanes derive from normalized levels;
- edge paths use shared SVG markers;
- search/filter changes retain node element identity;
- selection and hover modify classes without rebuilding the viewport;
- topology updates add and remove keyed elements correctly;
- reduced-motion behavior remains CSS-controlled;
- graph values are never interpolated through `innerHTML`.

### Build parity

Preserve tests asserting:

- `claude/viewer` and `cursor/viewer` outputs are byte-identical;
- dagre bundle exposes `globalThis.dagre`;
- generated app output avoids unsafe graph-data HTML interpolation;
- local CI builds viewer assets before tests that inspect them.

## Files in Scope

- `apps/gk/src/viewer/app.ts`
- `apps/gk/src/viewer/view.ts` only if a new pure policy is needed
- `apps/gk/claude/viewer/index.html`
- `apps/gk/claude/viewer/styles.css`
- corresponding `apps/gk/cursor/viewer` generated/mirrored assets
- `apps/gk/tests/helpers/fake-dom.ts`
- viewer unit/integration/parity tests
- build script only if marker or source asset generation requires it

The implementation must follow the active repository layout at execution time. The current feature branch retains `apps/gk`; `main` has since promoted this package to the repository root. The implementation plan must target the branch where work will be applied and must not mix layouts.

## Explicit Non-goals

- minimap;
- drag-to-rearrange or persisted manual layout;
- editable topology;
- edge labels absent from the schema;
- agent-based grouping;
- share links or saved viewport state;
- new runtime dependencies;
- replacement of dagre.

These features require demonstrated demand before entering scope.

## Acceptance Criteria

1. Default viewer presentation is a polished, dark-first editorial graph.
2. Phase lanes make fan-out, fan-in, and sequential workflow structure legible.
3. Hover, focus, and selection highlight the intended neighborhood without DOM reconstruction.
4. Search and filters dim rather than remove non-matches.
5. Smooth, restrained motion works normally and disappears under reduced-motion preference.
6. Live graph updates preserve viewport and valid selection, while incrementally reconciling SVG elements.
7. Existing security, accessibility, stale-data, keyboard, and parity guarantees remain green.
8. No new dependency is added.
