# Graph Viewer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dark-first editorial `gk:visualize` viewer that exposes workflow phases, renders calm directional edges, incrementally updates stable SVG elements, and animates interaction accessibly.

**Architecture:** Keep normalized graph data and dagre layout unchanged. Refactor the browser renderer into three stable SVG layers (`lane-layer`, `edge-layer`, `node-layer`) backed by keyed DOM maps; topology updates reconcile those maps, while search, filters, hover, focus, and selection only update classes. CSS owns the editorial design system and motion; the existing drawer remains the progressive-detail surface.

**Tech Stack:** Bun 1.3.9, TypeScript, SVG, CSS, dagre IIFE, Bun tests, purpose-built fake DOM.

## Global Constraints

- Before Task 1, invoke the `frontend-design` skill and use the approved spec plus Image #3 as the visual direction.
- Apply `cathrynlavery/diagram-design` principles: density 4/10, one focal accent, semantic tokens, restrained decoration, strong hierarchy.
- Target the repo-root layout (source under `src/`, not `apps/gk/`); run commands from the worktree root unless noted.
- Preserve CSP `script-src 'self'`; no inline scripts, remote assets, or data interpolation through `innerHTML`.
- Keep `claude/viewer` and `cursor/viewer` assets byte-identical.
- Keep dagre as the bundled IIFE layout engine; add no runtime or development dependencies.
- Preserve `MAX_NODES = 250`, stale-valid-graph behavior, pan/zoom, live updates, drawer behavior, search, filters, and keyboard operation.
- Model color must always be paired with model text.
- Disable all non-essential motion under `prefers-reduced-motion: reduce`.
- Do not commit generated `app.js`, `server.mjs`, or `dagre.js`; they remain CI build products. Commit source HTML/CSS because they are shipped assets.

## File Structure

- `src/viewer/app.ts` — browser orchestration, dagre layout, keyed SVG reconciliation, canvas interaction.
- `src/viewer/view.ts` — existing pure search/filter/emphasis policies; change only if a new DOM-free policy is necessary.
- `claude/viewer/index.html` — accessible toolbar shell and empty SVG host.
- `claude/viewer/styles.css` — semantic theme tokens, lanes, node cards, edges, drawer, motion.
- `cursor/viewer/index.html` — byte-identical copy of Claude asset.
- `cursor/viewer/styles.css` — byte-identical copy of Claude asset.
- `tests/helpers/fake-dom.ts` — test-only APIs and viewer inspection helpers.
- `tests/unit/viewer-dom.test.ts` — executed renderer behavior and element-identity tests.
- `tests/unit/viewer-parity.test.ts` — static security, parity, visual-contract, and bundle checks.

---

### Task 1: Dark-first editorial shell

**Files:**
- Modify: `claude/viewer/index.html:2-43`
- Modify: `claude/viewer/styles.css:1-355`
- Modify: `cursor/viewer/index.html:2-43`
- Modify: `cursor/viewer/styles.css:1-355`
- Test: `tests/unit/viewer-parity.test.ts:96-113`

**Interfaces:**
- Consumes: existing toolbar element IDs used by `app.ts`.
- Produces: `#toggle-lanes: HTMLInputElement`; CSS classes `.lane`, `.lane-label`, `.node-tier-rail`, `.node-badge`, `.selected`; semantic tokens `--ink`, `--muted`, `--hairline`, `--accent`.

- [ ] **Step 1: Write failing static-contract tests**

Replace the final token test and add an editorial-shell test in `viewer-parity.test.ts`:

```ts
test("viewer is dark-first with complete explicit light and dark palettes", () => {
  const css = readFileSync(join(claudeViewer, "styles.css"), "utf-8");
  for (const token of ["--bg", "--surface", "--ink", "--muted", "--hairline", "--accent", "--tier-opus"]) {
    expect(css, `${token} default`).toMatch(new RegExp(`:root\\s*\\{[^}]*${token}:`, "s"));
    expect(css, `${token} light`).toMatch(new RegExp(`data-theme="light"\\]\\s*\\{[^}]*${token}:`, "s"));
    expect(css, `${token} dark`).toMatch(new RegExp(`data-theme="dark"\\]\\s*\\{[^}]*${token}:`, "s"));
  }
  expect(css).toContain("prefers-reduced-motion: reduce");
});

test("editorial shell exposes phase-lane and card styling hooks", () => {
  const html = readFileSync(join(claudeViewer, "index.html"), "utf-8");
  const css = readFileSync(join(claudeViewer, "styles.css"), "utf-8");
  expect(html).toContain('id="toggle-lanes"');
  expect(html).toContain('aria-label="Show phase lanes"');
  for (const hook of [".lane", ".lane-label", ".node-tier-rail", ".node-badge", ".node-group.selected"]) {
    expect(css).toContain(hook);
  }
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
bun test tests/unit/viewer-parity.test.ts
```

Expected: FAIL because `--ink`, `--muted`, `--hairline`, `#toggle-lanes`, and new visual hooks do not exist.

- [ ] **Step 3: Add the lane control without changing existing IDs**

In `claude/viewer/index.html`, change the root to explicit dark-first system behavior and add the control before Reset:

```html
<html lang="en">
```

```html
<label class="ctrl ctrl-check">
  <input type="checkbox" id="toggle-lanes" aria-label="Show phase lanes" checked />
  <span>phases</span>
</label>
```

Do not add inline SVG definitions or scripts. The renderer will create shared SVG definitions so the fake DOM and live canvas use one code path.

- [ ] **Step 4: Replace component-colored CSS with semantic editorial tokens**

Use this token structure at the top of `claude/viewer/styles.css`; keep complete values in all three blocks:

```css
:root {
  color-scheme: dark;
  --bg: #0d1117;
  --surface: #161b22;
  --surface-2: #21262d;
  --ink: #e6edf3;
  --muted: #7d8590;
  --hairline: #30363d;
  --accent: #58a6ff;
  --danger: #f85149;
  --ok: #3fb950;
  --tier-opus: #bc8cff;
  --tier-sonnet: #58a6ff;
  --tier-haiku: #3fb950;
  --tier-fable: #f0883e;
  --tier-default: #8b949e;
  --dim: 0.25;
  --shadow: 0 10px 28px rgb(0 0 0 / 32%);
  --transition: 160ms cubic-bezier(0.2, 0, 0, 1);
}

:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f6f8fa;
  --surface: #ffffff;
  --surface-2: #eef1f4;
  --ink: #1f2328;
  --muted: #57606a;
  --hairline: #d0d7de;
  --accent: #0969da;
  --danger: #cf222e;
  --ok: #1a7f37;
  --tier-opus: #8250df;
  --tier-sonnet: #0969da;
  --tier-haiku: #1a7f37;
  --tier-fable: #bc4c00;
  --tier-default: #6e7781;
  --dim: 0.25;
  --shadow: 0 10px 28px rgb(31 35 40 / 14%);
  --transition: 160ms cubic-bezier(0.2, 0, 0, 1);
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0d1117;
  --surface: #161b22;
  --surface-2: #21262d;
  --ink: #e6edf3;
  --muted: #7d8590;
  --hairline: #30363d;
  --accent: #58a6ff;
  --danger: #f85149;
  --ok: #3fb950;
  --tier-opus: #bc8cff;
  --tier-sonnet: #58a6ff;
  --tier-haiku: #3fb950;
  --tier-fable: #f0883e;
  --tier-default: #8b949e;
  --dim: 0.25;
  --shadow: 0 10px 28px rgb(0 0 0 / 32%);
  --transition: 160ms cubic-bezier(0.2, 0, 0, 1);
}
```

Replace uses of `--text`, `--text-dim`, `--border`, `--edge`, and `--edge-emph` with `--ink`, `--muted`, `--hairline`, and `--accent`. Add the approved hooks:

```css
.lane { fill: color-mix(in srgb, var(--surface) 36%, transparent); stroke: var(--hairline); }
.lane.alt { fill: color-mix(in srgb, var(--surface-2) 30%, transparent); }
.lane-label { fill: var(--muted); font: 600 10px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
.node-tier-rail { pointer-events: none; }
.node-badge { fill: var(--muted); font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
.node-group.selected .node-rect { stroke: var(--accent); stroke-width: 3; filter: drop-shadow(0 0 8px color-mix(in srgb, var(--accent) 35%, transparent)); }
```

Keep controls and body painted explicitly. Remove the default-system media token duplication; explicit blocks now provide complete palettes.

- [ ] **Step 5: Mirror source assets byte-for-byte**

Run:

```bash
cp claude/viewer/index.html cursor/viewer/index.html && cp claude/viewer/styles.css cursor/viewer/styles.css
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
bun test tests/unit/viewer-parity.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add claude/viewer/index.html claude/viewer/styles.css \
  cursor/viewer/index.html cursor/viewer/styles.css \
  tests/unit/viewer-parity.test.ts
git commit -m "style: add editorial viewer shell

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Stable keyed SVG renderer

**Files:**
- Modify: `src/viewer/app.ts:22-290,504-527,549-584`
- Modify: `tests/helpers/fake-dom.ts:199-266,355-406`
- Test: `tests/unit/viewer-dom.test.ts:137-168`

**Interfaces:**
- Consumes: `ViewerGraph`, existing dagre layout output, existing `isVisible`, `emphasisIds`, and viewport state.
- Produces: stable `layers`, `nodeEls`, `edgeEls`, `laneEls` maps; `reconcileTopology(): void`; `updateViewState(): void`; `edgeKey(from, to): string`.

- [ ] **Step 1: Add failing identity and reconciliation tests**

Extend `ViewerHarness` and its implementation:

```ts
viewport(): FakeEl | null;
edge(from: string, to: string): FakeEl | null;
lane(level: number): FakeEl | null;
```

```ts
viewport: () => doc.ids.canvas.querySelector("g.viewport"),
edge: (from, to) => doc.ids.canvas.querySelector(`path.edge[data-from="${from}"][data-to="${to}"]`),
lane: (level) => doc.ids.canvas.querySelector(`[data-level="${level}"]`),
```

Add these tests to `viewer-dom.test.ts`:

```ts
test("search updates classes without replacing node or viewport elements", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", { a: node("a", { skills: ["rocket"] }), b: node("b", { skills: ["anchor"] }) }),
  );
  await flush();
  const viewport = harness.viewport();
  const a = harness.nodeGroup("a");
  harness.setSearch("rocket");
  expect(harness.viewport()).toBe(viewport);
  expect(harness.nodeGroup("a")).toBe(a);
  expect(harness.nodeGroup("b")?.classList.contains("filtered")).toBe(true);
});

test("graph updates reconcile keyed nodes instead of replacing retained nodes", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a"), b: node("b", { depend_on: ["a"] }) }));
  await flush();
  const a = harness.nodeGroup("a");
  harness.emitUpdate({ type: "graph", graph: graph("g", { a: node("a", { objective: "changed" }), c: node("c", { depend_on: ["a"] }) }) });
  await flush();
  expect(harness.nodeGroup("a")).toBe(a);
  expect(harness.nodeGroup("b")).toBeNull();
  expect(harness.nodeGroup("c")).not.toBeNull();
});
```

- [ ] **Step 2: Build and run tests to prove current teardown fails**

Run:

```bash
bun run build:viewer && bun test tests/unit/viewer-dom.test.ts
```

Expected: FAIL because `draw()` replaces the viewport and all nodes.

- [ ] **Step 3: Introduce stable renderer state**

In `app.ts`, replace the single mutable viewport rendering approach with typed indexes:

```ts
type PositionedNode = { x: number; y: number; width: number; height: number; node: ViewerGraph["nodes"][string] };
type PositionedEdge = { v: string; w: string; points?: Array<{ x: number; y: number }> };
type Layers = { lanes: SVGGElement; edges: SVGGElement; nodes: SVGGElement };

var viewport: SVGGElement;
var layers: Layers;
var nodeEls = new Map<string, SVGGElement>();
var edgeEls = new Map<string, SVGPathElement>();
var laneEls = new Map<number, SVGGElement>();

function edgeKey(from: string, to: string): string {
  return from + " " + to;
}
```

Keep `root` only if needed for compatibility; prefer one `viewport` reference rather than querying it.

- [ ] **Step 4: Create SVG definitions and stable layers once**

Add this initialization helper and call it once from `init()`:

```ts
function initCanvas(): void {
  var defs = el("defs");
  var marker = el("marker", {
    id: "arrow",
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "7",
    markerHeight: "7",
    orient: "auto-start-reverse",
  });
  marker.appendChild(el("path", { class: "arrow-marker", d: "M 0 0 L 10 5 L 0 10 z" }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  viewport = el("g", { class: "viewport" }) as SVGGElement;
  layers = {
    lanes: el("g", { class: "lane-layer" }) as SVGGElement,
    edges: el("g", { class: "edge-layer" }) as SVGGElement,
    nodes: el("g", { class: "node-layer" }) as SVGGElement,
  };
  viewport.appendChild(layers.lanes);
  viewport.appendChild(layers.edges);
  viewport.appendChild(layers.nodes);
  svg.appendChild(viewport);
}
```

Update `setView()` to set `viewport` directly.

- [ ] **Step 5: Reconcile keyed nodes and edges**

Replace `draw()` with two operations:

```ts
function removeMissing<K, E extends Element>(index: Map<K, E>, wanted: Set<K>): void {
  index.forEach((element, key) => {
    if (wanted.has(key)) return;
    element.parentNode?.removeChild(element);
    index.delete(key);
  });
}

function reconcileTopology(): void {
  var wantedNodes = new Set(Object.keys(state.nodes));
  removeMissing(nodeEls, wantedNodes);
  for (const id of wantedNodes) {
    var group = nodeEls.get(id);
    if (!group) {
      group = createNodeElement(id);
      nodeEls.set(id, group);
      layers.nodes.appendChild(group);
    }
    updateNodeElement(group, id);
  }

  var wantedEdges = new Set(state.edges.map((edge) => edgeKey(edge.v, edge.w)));
  removeMissing(edgeEls, wantedEdges);
  state.edges.forEach((edge) => {
    var key = edgeKey(edge.v, edge.w);
    var path = edgeEls.get(key);
    if (!path) {
      path = createEdgeElement(edge);
      edgeEls.set(key, path);
      layers.edges.appendChild(path);
    }
    updateEdgeElement(path, edge);
  });

  updateViewState();
}
```

Extract the current node event wiring into `createNodeElement(id)`. Put changing position, text, model rail color, ARIA label, and badges in `updateNodeElement`. Put changing path geometry in `updateEdgeElement`. Event handlers must read `group.dataset.id` at event time so retained elements continue to work after graph updates.

- [ ] **Step 6: Make view-state changes class-only**

Implement:

```ts
function updateViewState(): void {
  var focusId = state.selected || state.hover || state.focus;
  var connected = emphasisIds(state.graph!, focusId);
  nodeEls.forEach((group, id) => {
    group.classList.remove("dim", "emph", "filtered", "selected");
    if (!isVisible(state.nodes[id].node)) group.classList.add("filtered");
    if (state.selected === id) group.classList.add("selected");
    if (connected) group.classList.add(connected.has(id) ? "emph" : "dim");
    group.dataset.visible = isVisible(state.nodes[id].node) ? "1" : "0";
  });
  edgeEls.forEach((path) => {
    path.classList.remove("dim", "emph-conn");
    var adjacent = path.dataset.from === focusId || path.dataset.to === focusId;
    if (connected) path.classList.add(adjacent ? "emph-conn" : "dim");
  });
}
```

Replace search/filter/reset calls to `draw()` with `updateViewState()`. Replace emphasis calls with `updateViewState()`. In `applyGraph`, call `layout()`, `reconcileTopology()`, then the existing header/filter/drawer/fit flow.

- [ ] **Step 7: Build and run renderer tests**

Run:

```bash
bun run build:viewer && bun test tests/unit/viewer-dom.test.ts tests/unit/viewer-parity.test.ts
```

Expected: PASS, including stable object identity across search and graph updates.

- [ ] **Step 8: Commit source and tests only**

```bash
git add src/viewer/app.ts tests/helpers/fake-dom.ts tests/unit/viewer-dom.test.ts
git commit -m "refactor: reconcile viewer SVG incrementally

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Phase lanes, editorial cards, and calm edges

**Files:**
- Modify: `src/viewer/app.ts` (layout constants, `reconcileLanes`, node/edge element helpers)
- Modify: `tests/helpers/fake-dom.ts:308-327`
- Test: `tests/unit/viewer-dom.test.ts`
- Test: `tests/unit/viewer-parity.test.ts`

**Interfaces:**
- Consumes: keyed layer/maps from Task 2 and normalized `ViewerNode.level`/`order`.
- Produces: `laneBounds(level): { x: number; y: number; width: number; height: number }`; `reconcileLanes(): void`; cubic path `d`; `marker-end="url(#arrow)"`; tier rail and optional loop/eval badges.

- [ ] **Step 1: Add failing executed visual-structure tests**

Add to `viewer-dom.test.ts`:

```ts
test("normalized levels render as stable phase lanes", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", {
    root: node("root", { level: 0, order: 0 }),
    worker: node("worker", { level: 1, order: 0, depend_on: ["root"] }),
  }));
  await flush();
  expect(harness.lane(0)?.classList.contains("lane-group")).toBe(true);
  expect(harness.lane(1)?.textContent).toContain("Phase 1");
});

test("edges share an SVG marker and use curved path geometry", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", {
    a: node("a"),
    b: node("b", { level: 1, depend_on: ["a"] }),
  }));
  await flush();
  const edge = harness.edge("a", "b");
  expect(edge?.getAttribute("marker-end")).toBe("url(#arrow)");
  expect(edge?.getAttribute("d")).toContain(" C ");
  expect(harness.doc.ids.canvas.querySelectorAll("path.edge-arrow")).toHaveLength(0);
});

test("node cards include a model rail, model text, and loop badge", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", {
    a: node("a", { model: "opus", loop: { enabled: true, max_rounds: 3 } }),
  }));
  await flush();
  const group = harness.nodeGroup("a")!;
  expect(group.querySelector("rect.node-tier-rail")).not.toBeNull();
  expect(group.querySelector("text.node-badge")?.textContent).toContain("↻");
  expect(group.textContent).toContain("opus");
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
bun run build:viewer && bun test tests/unit/viewer-dom.test.ts
```

Expected: FAIL because lanes, markers, cubic paths, tier rails, and badges are absent.

- [ ] **Step 3: Make fake dagre positions respect normalized rank in tests**

The production dagre result already follows dependency rank. Adjust the fake layout to produce predictable vertical phases:

```ts
Object.keys(g.nodes).forEach((id, i) => {
  g.nodes[id].x = 160 + i * 220;
  g.nodes[id].y = 120 + i * 150;
});
```

Keep edge point generation. This is test geometry only.

- [ ] **Step 4: Reconcile phase lanes from node bounds**

Use normalized levels, not y-coordinate inference:

```ts
function laneBounds(level: number) {
  var nodes = Object.values(state.nodes).filter((entry) => entry.node.level === level);
  var bounds = graphBounds();
  var minY = Math.min(...nodes.map((entry) => entry.y - entry.height / 2)) - 34;
  var maxY = Math.max(...nodes.map((entry) => entry.y + entry.height / 2)) + 34;
  return { x: bounds.x - 28, y: minY, width: bounds.w + 56, height: maxY - minY };
}

function reconcileLanes(): void {
  var levels = new Set(Object.values(state.nodes).map((entry) => entry.node.level));
  removeMissing(laneEls, levels);
  [...levels].sort((a, b) => a - b).forEach((level) => {
    var group = laneEls.get(level);
    if (!group) {
      group = el("g", { class: "lane-group", "data-level": String(level) }) as SVGGElement;
      group.appendChild(el("rect", { class: level % 2 ? "lane alt" : "lane" }));
      var label = el("text", { class: "lane-label" });
      group.appendChild(label);
      laneEls.set(level, group);
      layers.lanes.appendChild(group);
    }
    var b = laneBounds(level);
    var rect = group.querySelector("rect.lane")!;
    rect.setAttribute("x", String(b.x));
    rect.setAttribute("y", String(b.y));
    rect.setAttribute("width", String(b.width));
    rect.setAttribute("height", String(b.height));
    var label = group.querySelector("text.lane-label")!;
    label.setAttribute("x", String(b.x + 12));
    label.setAttribute("y", String(b.y + 18));
    label.textContent = "Phase " + level;
  });
}
```

Call `reconcileLanes()` before edge and node reconciliation. Set lane-layer visibility from `state.showLanes` and wire `#toggle-lanes` to update it without layout.

- [ ] **Step 5: Replace polyline and manual arrows with cubic paths and marker**

Implement geometry using dagre's first and last edge points:

```ts
function curvedPath(points: Array<{ x: number; y: number }>): string {
  var first = points[0];
  var last = points[points.length - 1];
  var midY = (first.y + last.y) / 2;
  return `M ${first.x},${first.y} C ${first.x},${midY} ${last.x},${midY} ${last.x},${last.y}`;
}
```

`createEdgeElement` sets stable attributes once:

```ts
return el("path", {
  class: "edge",
  "data-from": edge.v,
  "data-to": edge.w,
  "marker-end": "url(#arrow)",
}) as SVGPathElement;
```

`updateEdgeElement` skips fewer than two points and otherwise sets `d = curvedPath(points)`. Delete all `edge-arrow` creation and lookup code.

- [ ] **Step 6: Render editorial node-card structure**

Use `NODE_W = 208`, `NODE_H = 64`. `createNodeElement` must create, in order:

```ts
var card = el("rect", { class: "node-rect", rx: "10" });
var rail = el("rect", { class: "node-tier-rail", width: "3", rx: "1.5" });
var idText = el("text", { class: "node-text-id" });
var subText = el("text", { class: "node-text-sub" });
var badgeText = el("text", { class: "node-badge", "text-anchor": "end" });
group.appendChild(card);
group.appendChild(rail);
group.appendChild(idText);
group.appendChild(subText);
group.appendChild(badgeText);
```

`updateNodeElement` positions text left-aligned, updates all text with `textContent`, sets the rail fill through `tierColor(node.model)`, and emits badges:

```ts
badgeText.textContent = [node.loop?.enabled ? "↻" : "", node.eval ? "◆" : ""].filter(Boolean).join(" ");
idText.textContent = node.id;
subText.textContent = node.agent + " · " + node.model;
```

Never use model color as the only model indicator.

- [ ] **Step 7: Add edge and entrance CSS**

In both CSS assets, ensure shared marker and card geometry inherit semantic tokens:

```css
.edge { fill: none; stroke: var(--hairline); stroke-width: 1.5; marker-end: url(#arrow); }
.arrow-marker { fill: var(--hairline); }
.edge.emph-conn { stroke: var(--accent); stroke-width: 3; filter: drop-shadow(0 0 4px color-mix(in srgb, var(--accent) 45%, transparent)); }
.node-group.is-new { animation: node-enter 240ms cubic-bezier(0.2, 0, 0, 1) both; animation-delay: calc(var(--level) * 30ms); }
@keyframes node-enter { from { opacity: 0; transform: translateY(6px); } }
```

Set each node group's inline custom property using the `style` attribute only for the normalized numeric level:

```ts
group.setAttribute("style", "--level:" + String(node.level));
```

Remove `.is-new` on `animationend`; retained nodes must not receive it again.

- [ ] **Step 8: Mirror CSS and run focused tests**

Run:

```bash
cp claude/viewer/styles.css cursor/viewer/styles.css && bun run build:viewer && bun test tests/unit/viewer-dom.test.ts tests/unit/viewer-parity.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/viewer/app.ts claude/viewer/styles.css cursor/viewer/styles.css \
  tests/helpers/fake-dom.ts tests/unit/viewer-dom.test.ts tests/unit/viewer-parity.test.ts
git commit -m "feat: reveal workflow phases in viewer

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Interaction polish, accessibility, and final verification

**Files:**
- Modify: `src/viewer/app.ts` (selection, lane toggle, ARIA, animation cleanup)
- Modify: `claude/viewer/styles.css` (focus, selected, dimmed, reduced motion)
- Modify: `cursor/viewer/styles.css`
- Test: `tests/unit/viewer-dom.test.ts`
- Test: `tests/unit/viewer-parity.test.ts`

**Interfaces:**
- Consumes: stable maps and visual structures from Tasks 2–3.
- Produces: class-only hover/focus/selection transitions; visible lane toggle; reduced-motion-safe motion; preserved interaction contracts.

- [ ] **Step 1: Add failing interaction tests**

Add harness support:

```ts
setLanes(checked: boolean): void;
```

```ts
setLanes: (checked) => {
  const control = doc.ids["toggle-lanes"];
  control.checked = checked;
  control.dispatch("change", { target: control });
},
```

Register `toggle-lanes` in `makeDocument()`. Add tests:

```ts
test("lane toggle hides lanes without replacing graph elements", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a") }));
  await flush();
  const a = harness.nodeGroup("a");
  harness.setLanes(false);
  expect(harness.viewport()?.querySelector("g.lane-layer")?.getAttribute("aria-hidden")).toBe("true");
  expect(harness.nodeGroup("a")).toBe(a);
});

test("selection uses a durable selected class and connected edge emphasis", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", {
    a: node("a"),
    b: node("b", { depend_on: ["a"] }),
    c: node("c"),
  }));
  await flush();
  harness.clickNode("a");
  expect(harness.nodeGroup("a")?.classList.contains("selected")).toBe(true);
  expect(harness.edge("a", "b")?.classList.contains("emph-conn")).toBe(true);
  expect(harness.nodeGroup("c")?.classList.contains("dim")).toBe(true);
});
```

Add a parity assertion:

```ts
expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none/);
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun run build:viewer && bun test tests/unit/viewer-dom.test.ts tests/unit/viewer-parity.test.ts
```

Expected: FAIL until lane toggling, durable selected styling, and reduced-motion animation suppression are complete.

- [ ] **Step 3: Wire lane visibility as a view-only update**

Add `showLanes: true` to state. Implement:

```ts
function updateLaneVisibility(): void {
  layers.lanes.setAttribute("aria-hidden", state.showLanes ? "false" : "true");
  layers.lanes.setAttribute("visibility", state.showLanes ? "visible" : "hidden");
}
```

Wire `#toggle-lanes` change to update `state.showLanes` and call only `updateLaneVisibility()`. Call it after layer initialization and reconciliation. Do not call dagre or replace nodes.

- [ ] **Step 4: Finalize interaction precedence**

Keep one explicit precedence rule:

```ts
var focusId = state.selected || state.hover || state.focus;
```

Selection locks emphasis; hover and focus do not override it. `select`, `goToNode`, background click, drawer close, and Escape all call `updateViewState()`. Node groups keep:

```ts
{
  tabindex: "0",
  role: "button",
  "aria-label": "Node " + node.id + ", agent " + node.agent + ", model " + node.model,
}
```

Enter selects. Tab order remains DOM insertion order from normalized `level`, `order`, and ID. Before appending new node elements, sort IDs using the existing `keyboardOrderBy` comparator rather than raw object order.

- [ ] **Step 5: Complete reduced-motion and state CSS**

Ensure CSS has distinct non-color cues and disables every introduced animation:

```css
.node-group { cursor: pointer; transform-box: fill-box; transform-origin: center; }
.node-group.emph .node-rect { stroke-width: 2.5; }
.node-group.dim, .edge.dim { opacity: var(--dim); }
.node-group.filtered { opacity: var(--dim); pointer-events: none; }
.node-group.selected { transform: translateY(-2px); }
.node-group:focus-visible .node-rect { stroke: var(--accent); stroke-width: 3; }

@media (prefers-reduced-motion: reduce) {
  .node-group,
  .node-rect,
  .edge,
  .arrow-marker {
    animation: none !important;
    transition: none !important;
  }
}
```

Mirror CSS afterward.

- [ ] **Step 6: Run all viewer tests**

Run:

```bash
cp claude/viewer/styles.css cursor/viewer/styles.css && bun run build:viewer && \
  bun test tests/unit/viewer-behavior.test.ts \
    tests/unit/viewer-dom.test.ts \
    tests/unit/viewer-normalize.test.ts \
    tests/unit/viewer-parity.test.ts \
    tests/integration/viewer-server.test.ts
```

Expected: all PASS.

- [ ] **Step 7: Run full local CI**

Run:

```bash
bun run ci:local
```

Expected: typecheck, lint, builds, viewer build, tests, and CBM parity all PASS. If unrelated pre-existing failures occur, record the exact command and failure; do not weaken tests.

- [ ] **Step 8: Manually inspect the real viewer**

Run:

```bash
bun src/cli/index.ts graph viewer graph.yaml
```

Open the printed authenticated URL. Verify:

1. dark-first palette and low-density editorial hierarchy;
2. lanes reveal phases and diamond composition;
3. edges are curved with one arrow marker each;
4. hover/focus highlights one-hop neighbors;
5. click locks selection and opens the drawer;
6. search/filter dim rather than remove nodes;
7. phase toggle does not move nodes;
8. pan, zoom, fit, Escape, Enter, and live reload still work;
9. OS reduced-motion disables entrance and transition motion.

Stop the viewer process after inspection.

- [ ] **Step 9: Commit final source and tests**

```bash
git add src/viewer/app.ts claude/viewer/styles.css cursor/viewer/styles.css \
  tests/helpers/fake-dom.ts tests/unit/viewer-dom.test.ts tests/unit/viewer-parity.test.ts
git commit -m "feat: polish interactive graph emphasis

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 10: Confirm generated artifacts remain untracked**

Run:

```bash
git status --short -- claude/viewer cursor/viewer
```

Expected: no `app.js`, `server.mjs`, or `dagre.js` staged or newly tracked; only source changes already committed.
