# Cross-Target Model Resolution, Skill Naming, and Interactive Viewer

**Date:** 2026-08-11  
**Status:** Approved

## Objective

Ship three independent improvements to GraphKit's dual-target (Claude Code / Cursor) kit:

1. **Model resolution for Cursor** — map GraphKit's `opus` / `sonnet` / `haiku` model tiers to Cursor's actual model names, with a static default map and a `gk models cursor` query/override command.
2. **Per-target skill naming** — keep the `gk:init-graph` colon namespace in Claude Code, use the `gk-init-graph` dash form in Cursor (which does not render the colon).
3. **Interactive viewer** — draggable nodes (manual nudge), auto-fitting node shapes, and marching-dash edge flow animation, while preserving the existing keyed-reconciliation renderer and byte-identical `claude/viewer` ↔ `cursor/viewer` parity.

## Constraints

- Preserve CSP `script-src 'self'; style-src 'self'` — no inline scripts/styles. Flow animation must be CSS/SVG attribute based.
- `claude/viewer` and `cursor/viewer` generated assets remain byte-identical. Viewer work happens only in the shared renderer `src/viewer/app.ts` and shared CSS.
- Preserve `prefers-reduced-motion`: all animation disabled under it.
- Keep pure state and graph rules in `src/viewer/view.ts`, DOM-free.
- `model` remains a hint field; the compiler does not execute models. The runtime dispatch skill (`gk:execute`) resolves the model name per target.
- No new runtime dependencies.
- Preserve the 250-node normalization limit.

---

## Part 1 — Per-Target Skill Naming

### Current state

Both `claude/skills/*/SKILL.md` and `cursor/skills/*/SKILL.md` declare `name: gk:init-graph` (colon). Claude Code renders the colon namespace (`/gk:init-graph`); Cursor strips the colon and shows `/gk-init-graph`. The kit-skill-parity test (`tests/unit/kit-skill-parity.test.ts`) checks directory presence only — not name content — so per-target names do not break parity.

### Change

| Kit | `name:` in SKILL.md | Shown command |
|---|---|---|
| `claude/` | `gk:init-graph` | `/gk:init-graph` |
| `cursor/` | `gk-init-graph` | `/gk-init-graph` |

Each kit is an independent source tree. Edit the `name:` frontmatter line in every Cursor skill that uses a colon, to the dash form:

- `cursor/skills/gk-brainstorm/SKILL.md` — `gk:brainstorm` → `gk-brainstorm`
- `cursor/skills/gk-init-graph/SKILL.md` — `gk:init-graph` → `gk-init-graph`
- `cursor/skills/gk-visualize/SKILL.md` — `gk:visualize` → `gk-visualize`
- (and the remaining `gk:*` skills in `cursor/skills/`)

Claude tree is unchanged. The `name:` change is only in the Cursor tree.

### Why not a shared transform

The claude→cursor copy is not automated; the two trees are already divergent (Cursor omits `gk-compile`, `gk-run`, uses lowercase hooks, Task tool dispatch). Editing each Cursor SKILL.md name line is a mechanical, reviewable change.

---

## Part 2 — Cursor Model Resolution

### Current state

`src/schemas/graph.schema.ts:4` pins `const NodeRef = z.enum(["opus", "sonnet", "haiku", "fable"])`. `graph.yaml` nodes declare `model: opus` etc. The compiler emits `.workflow.js` with `model: nodes.X.model`. The runtime dispatch skill reads the node's `model` tier and passes it to the model runner.

For Cursor, `/gk:execute` dispatches subagents via the Task tool using the node's model tier verbatim. Cursor may not have `opus` / `sonnet` / `haiku` as valid model names, so the dispatch must resolve to a real Cursor model.

### Change

**Static default map** (baked into the Cursor kit, configurable):

| GraphKit tier | Cursor model |
|---|---|
| `opus` | `Grok 4.5` |
| `sonnet` | `Composer 2.5` |
| `haiku` | `Auto` |
| `fable` | `Auto` |

**New CLI subcommand family** `gk models`:

- `gk models cursor` — prints available Cursor model names and the current mapping (defaults + any overrides).
- `gk models cursor set --map sonnet=composer-2.5` — writes an override to `.graphkit/models.cursor.json`.
- `gk models cursor reset` — removes overrides.

The mapping is resolved at dispatch time by the Cursor `gk:execute` skill: it reads the node's `model`, looks up the map (override file first, then defaults), and passes the resolved name to the Task tool.

### Where the map lives

- Default map: a small TS module `src/models/cursor-map.ts` exporting `CURSOR_MODEL_DEFAULTS`.
- Overrides: `.graphkit/models.cursor.json`, read if present, merged over defaults.
- The Cursor `gk:execute` skill doc lists the mapping so a human agent following it resolves the same way.

---

## Part 3 — Interactive Viewer

All changes in shared renderer `src/viewer/app.ts` + shared `claude/viewer/styles.css` (mirrored to `cursor/viewer` by the existing build). No per-target divergence.

### 3a. Draggable nodes (manual nudge)

**Behavior:** pointer-down on a node group starts a drag. Pointer-move updates the node's `transform` translate. Drag ends on pointer-up. Edges remain anchored to the dagre-computed port positions (edge paths are not re-routed during a drag). On the next topology recompute (search, filter, live update), dagre re-layouts and nodes snap back to computed positions. No persistence.

**Implementation:** the existing `mousedown` on `svg` returns early when the target is inside a `g.node-group` (pan skip). Add a drag handler: on node `mousedown`, record node id + pointer start; on `mousemove` (already a `window` listener), if a drag anchor is set and the node is the drag target, set the node group's `transform` instead of panning. Clear drag state on `mouseup`.

**Reduced motion:** drag itself is a direct pointer interaction, not an animation — no CSS transition on the dragged node while dragging. (Node hover/emphasis transitions remain disabled under reduced motion as today.)

### 3b. Auto-fitting node shapes

**Current:** fixed `NODE_W = 208`, `NODE_H = 64` (`src/viewer/app.ts:11-12`). All cards identical; dense or long labels clip or overflow.

**Change:** measure each node's rendered card before layout. A hidden probe renders the card template offscreen; after mount, `getBBox()`/`scrollWidth` of the node's text gives the intrinsic size. Feed per-node `width`/`height` into dagre `g.setNode(id, { width, height, ... })` so dagre sizes the node and routes edges around the real footprint.

**Reconciliation:** per-node measured size is cached keyed by node id. Re-measure only when the node's content (title/agent/model/loops) changes — detect via a content-hash or a `data-content-key` attribute. Unchanged nodes reuse cached size; dagre layout still runs each topology update but with stable dimensions for unchanged nodes.

**Keyed SVG reconciliation** (existing `nodeEls`/`edgeEls`/`laneEls` Maps) is preserved: node size changes update the card group attributes in place; they never destroy/recreate elements.

### 3c. Edge flow animation (marching dashes)

**Behavior:** edges carry a marching-dash animation whose direction flows toward the target node. Idle edges get slow, subtle dashes; emphasized edges (hover/selection neighborhood) get faster, brighter flow.

**Implementation (CSP-safe, CSS only):**
- Each edge path uses a `stroke-dasharray` set in CSS (or the `stroke-dasharray` SVG presentation attribute).
- A `@keyframes` on `stroke-dashoffset` animates the dash pattern so it appears to travel along the path.
- Direction is derived from the edge's `data-from`/`data-to`; if the path direction must match, set `stroke-dashoffset` polarity accordingly (both endpoints of a cubic path read the same direction convention as the existing arrow markers).
- Emphasis state toggles a class on the edge element (existing `.is-emphasized` mechanism) that switches to the faster/brighter dash animation.
- Reduced motion: the reduced-motion block disables the animation (existing).

---

## Data Flow (viewer)

1. Server emits normalized graph (HTTP or SSE).
2. `applyGraph` retains valid selection/viewport.
3. Measure/cache node sizes; dagre layout with per-node dimensions.
4. Reconcile keyed SVG elements (lanes, edges, nodes).
5. Drag handler updates node `transform`; no layout recompute.
6. View-state changes toggle classes without re-layout.

## Error Handling

- Drag during a live topology update: the drag anchor is cleared on any graph apply, so a node mid-drag snaps to its new layout position rather than fighting the update.
- Missing measured size for a node: fall back to `NODE_W`/`NODE_H` defaults.
- Missing Cursor model in map: fall back to `Auto`, log a warning.
- `gk models cursor` with no Cursor runtime: print the default map + a note that availability is runtime-dependent.

## Accessibility

- Drag must not break keyboard selection, centering, or zoom.
- Edge flow is decorative; it carries no information that isn't already in the arrowheads. It is disabled under reduced motion.
- Auto-fit must not make cards smaller than a legible minimum; enforce a floor on measured size.

## Testing

### Unit (pure)

- `src/models/cursor-map.ts`: default map resolution, override merge, reset.
- `src/viewer/view.ts` additions if any pure size/flow helpers are extracted.

### Viewer integration (fake DOM)

- Drag: `mousedown` on a node group sets a drag anchor; `mousemove` changes the node `transform`; `mouseup` clears it. Pan is not triggered when dragging a node.
- Auto-fit: nodes with long labels get a larger measured size; cached size reused when content unchanged.
- Edge flow: edge paths have `stroke-dasharray`/`data-dash` and the keyframe class; reduced-motion disables the animation.

### Build parity

- `claude/viewer` and `cursor/viewer` remain byte-identical after the viewer changes (existing parity test).
- `gk models` commands: CLI parity gate (`scripts/check-cli-parity.ts`) updated if the command surface changes.

## Files in Scope

- `src/schemas/graph.schema.ts` — only if the `fable`→`Auto` mapping needs a schema affordance (likely unchanged).
- `src/models/cursor-map.ts` — new.
- `src/cli/commands/models.ts` — new `gk models` subcommand.
- `src/cli/command-registry.ts` — register `models`.
- `src/index.ts` — register `models` command.
- `src/viewer/app.ts` — drag, auto-fit, edge-flow wiring.
- `claude/viewer/styles.css` (→ `cursor/viewer/styles.css` by build) — dash keyframes, drag cursor, reduced-motion guards.
- `cursor/skills/*/SKILL.md` — `name:` dash form.
- `cursor/skills/gk-execute/SKILL.md` — document model mapping.
- `src/cli/commands/kit.ts` — only if `gk models` installs/reads `.graphkit/models.cursor.json` through a shared path helper.
- Tests: `tests/unit/cursor-model-map.test.ts`, `tests/unit/cli-models.test.ts`, viewer drag/autofit/flow tests, `tests/unit/kit-skill-parity.test.ts` (verify still green).

## Explicit Non-goals

- Persisted manual layout (drag survives recompute) — explicitly rejected; manual nudge only.
- Edge re-routing during drag.
- A dynamic "ask Cursor which models are available at runtime" call for every dispatch.
- Changing the `model` schema enum.
- New runtime dependencies.

## Acceptance Criteria

1. Cursor skill commands render as `/gk-init-graph` (dash); Claude keeps `/gk:init-graph` (colon).
2. `gk models cursor` prints the mapping; `set`/`reset` override it via `.graphkit/models.cursor.json`.
3. Cursor `/gk:execute` resolves each node model through the map (override → default → `Auto`).
4. Viewer nodes drag to a new spot; next layout recompute snaps them back.
5. Viewer node cards auto-size to their content; dagre routes around the real footprint.
6. Edges show directional marching-dash flow; disabled under reduced motion.
7. `claude/viewer` ↔ `cursor/viewer` stay byte-identical.
8. No new dependency; 250-node limit intact.
