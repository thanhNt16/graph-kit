/* GraphKit viewer — browser runtime. All graph values are inserted as text
   nodes, never innerHTML. Reads the normalized graph from the server.
   Bundled to claude/viewer/app.js + cursor/viewer/app.js by scripts/build-viewer.sh.
   Pure search/filter/emphasis/state rules live in view.ts and are unit-tested. */

import type { ViewerGraph } from "./normalize.js";
import { emphasisIds, type Filters, matchesSearch, passesFilters, retainedSelection, shouldFit } from "./view.js";

(() => {
  var KEY = new URLSearchParams(location.search).get("key") || "";
  var NODE_W = 208;
  var NODE_H = 64;
  var nodeSizes = new Map<string, { width: number; height: number; key: string }>();
  var probeEl: SVGGElement | null = null;
  var TIERS = ["opus", "sonnet", "haiku", "fable"];
  var COLOR = {
    opus: "var(--tier-opus)",
    sonnet: "var(--tier-sonnet)",
    haiku: "var(--tier-haiku)",
    fable: "var(--tier-fable)",
    default: "var(--tier-default)",
  };

  var state = {
    graph: null as ViewerGraph | null,
    nodes: {} as Record<string, PositionedNode>,
    edges: [] as PositionedEdge[],
    selected: null as string | null,
    hover: null as string | null,
    focus: null as string | null, // path-emphasis source from keyboard focus
    search: "",
    filterModel: "",
    filterAgent: "",
    filterLoop: false,
    showLanes: true,
    view: null as { x: number; y: number; k: number } | null,
    minK: 0.05,
    maxK: 4,
  };

  type PositionedNode = { x: number; y: number; width: number; height: number; node: ViewerGraph["nodes"][string] };
  type PositionedEdge = { v: string; w: string; points?: Array<{ x: number; y: number }> };
  type Layers = { lanes: SVGGElement; edges: SVGGElement; nodes: SVGGElement };

  var svg: SVGSVGElement;
  var viewport: SVGGElement;
  var layers: Layers;
  var nodeEls = new Map<string, SVGGElement>();
  var edgeEls = new Map<string, SVGPathElement>();
  var laneEls = new Map<number, SVGGElement>();
  var nodeParts = new WeakMap<SVGGElement, { rect: any; rail: any; idText: any; subText: any; badgeText: any }>();
  var drawer: HTMLElement;
  var drawerBody: HTMLElement;
  var drawerTitle: HTMLElement;
  var searchEl: HTMLInputElement;
  var mouseAnchor: { x: number; y: number; view: { x: number; y: number; k: number } } | null = null;
  // Manual-nudge drag state — ephemeral, cleared on mouseup and any graph apply.
  var dragNodeId: string | null = null;
  var dragAnchor: { x: number; y: number; tx: number; ty: number } | null = null;

  function el(tag: string, props?: Record<string, string>, children?: Node[]) {
    var n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (props) for (var k in props) n.setAttribute(k, props[k]);
    (children || []).forEach((c) => {
      n.appendChild(c);
    });
    return n;
  }

  function textNode(content: unknown) {
    return document.createTextNode(content == null ? "" : String(content));
  }

  function tierColor(model: string) {
    return COLOR[model as keyof typeof COLOR] || COLOR.default;
  }

  function nodeTitle(node: any) {
    return node.id + "\n" + node.agent + " · " + node.model;
  }

  function nodeContentKey(node: any): string {
    return [node.id, node.agent, node.model, node.loop?.enabled ? "loop" : "", node.eval ? "eval" : ""].join("~");
  }

  function nodeSizeFor(node: any): { width: number; height: number } {
    var key = nodeContentKey(node);
    var cached = nodeSizes.get(node.id);
    if (cached && cached.key === key) {
      return { width: cached.width, height: cached.height };
    }
    var probe = probeEl;
    if (!probe) {
      return { width: NODE_W, height: NODE_H };
    }
    // reset the probe with the card's two real <text> elements (same classes
    // as updateNodeElement) so getBBox measures actual rendered text geometry
    probe.textContent = "";
    var idText = el("text", { class: "node-text-id" });
    idText.appendChild(textNode(node.id));
    var subText = el("text", { class: "node-text-sub" });
    subText.appendChild(textNode(node.agent + " · " + node.model));
    probe.appendChild(idText);
    probe.appendChild(subText);
    var w = Math.max(NODE_W, idText.getBBox().width + 24);
    var h = Math.max(NODE_H, idText.getBBox().height + subText.getBBox().height + 16);
    nodeSizes.set(node.id, { width: w, height: h, key });
    return { width: w, height: h };
  }

  function layout() {
    var g = new (dagre as any).graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 70, marginx: 40, marginy: 40 });
    g.setDefaultEdgeLabel(() => ({}));
    Object.keys(state.graph!.nodes).forEach((id) => {
      var size = nodeSizeFor(state.graph!.nodes[id]);
      g.setNode(id, { width: size.width, height: size.height, label: nodeTitle(state.graph!.nodes[id]) });
    });
    Object.keys(state.graph!.nodes).forEach((id) => {
      state.graph!.nodes[id].depend_on.forEach((dep: string) => {
        if (state.graph!.nodes[dep]) g.setEdge(dep, id);
      });
    });
    (dagre as any).layout(g);
    state.nodes = {};
    state.edges = [];
    Object.keys(state.graph!.nodes).forEach((id) => {
      var p = g.node(id);
      state.nodes[id] = {
        x: p.x,
        y: p.y,
        width: p.width || NODE_W,
        height: p.height || NODE_H,
        node: state.graph!.nodes[id],
      };
    });
    g.edges().forEach((e: any) => {
      var label = g.edge(e) || {};
      state.edges.push({ v: e.v, w: e.w, points: label.points });
    });
  }

  function graphBounds() {
    var minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    Object.keys(state.nodes).forEach((id) => {
      var n = state.nodes[id];
      minX = Math.min(minX, n.x - n.width / 2);
      maxX = Math.max(maxX, n.x + n.width / 2);
      minY = Math.min(minY, n.y - n.height / 2);
      maxY = Math.max(maxY, n.y + n.height / 2);
    });
    if (!isFinite(minX)) return { x: 0, y: 0, w: 600, h: 400 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function edgeKey(from: string, to: string): string {
    return from.length + ":" + from + to.length + ":" + to;
  }

  /**
   * Cubic Bezier between dagre's first and last edge points, bowed toward the
   * vertical midpoint so multi-hop runs read as gentle curves instead of
   * sharp corners. Minimal added control — one focal accent discipline.
   */
  function curvedPath(points: Array<{ x: number; y: number }>): string {
    var first = points[0];
    var last = points[points.length - 1];
    var midY = (first.y + last.y) / 2;
    return "M " + first.x + "," + first.y + " C " + first.x + "," + midY + " " + last.x + "," + midY + " " + last.x + "," + last.y;
  }

  function laneBounds(level: number) {
    var nodes = Object.values(state.nodes).filter((entry) => entry.node.level === level);
    var bounds = graphBounds();
    var minY = Math.min(...nodes.map((entry) => entry.y - entry.height / 2)) - 34;
    var maxY = Math.max(...nodes.map((entry) => entry.y + entry.height / 2)) + 34;
    return { x: bounds.x - 28, y: minY, width: bounds.w + 56, height: maxY - minY };
  }

  function reconcileLanes(): void {
    var levels = new Set(Object.values(state.nodes).map((entry) => entry.node.level));
    removeMissing<number, Element>(laneEls, levels);
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
      var label2 = group.querySelector("text.lane-label")!;
      label2.setAttribute("x", String(b.x + 12));
      label2.setAttribute("y", String(b.y + 18));
      label2.textContent = "Phase " + level;
    });
  }

  function parseTransform(g: SVGGElement | undefined): { tx: number; ty: number } {
    if (!g) return { tx: 0, ty: 0 };
    var t = g.getAttribute("transform") || "";
    var m = t.match(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)/);
    return m ? { tx: parseFloat(m[1]), ty: parseFloat(m[2]) } : { tx: 0, ty: 0 };
  }

  function setView(v: { x: number; y: number; k: number }) {
    state.view = v;
    if (viewport) viewport.setAttribute("transform", "translate(" + v.x + "," + v.y + ") scale(" + v.k + ")");
  }

  function fitView() {
    var b = graphBounds();
    var vw = svg.clientWidth,
      vh = svg.clientHeight;
    if (!vw) vw = window.innerWidth;
    if (!vh) vh = window.innerHeight;
    var k = Math.min(vw / b.w, vh / b.h, 1.2);
    k = Math.max(k, state.minK);
    setView({ x: vw / 2 - (b.x + b.w / 2) * k, y: vh / 2 - (b.y + b.h / 2) * k, k: k });
  }

  function zoomBy(factor: number, cx: number, cy: number) {
    var v = state.view || { x: 0, y: 0, k: 1 };
    var k = Math.min(Math.max(v.k * factor, state.minK), state.maxK);
    var ratio = k / v.k;
    var x = cx - (cx - v.x) * ratio;
    var y = cy - (cy - v.y) * ratio;
    setView({ x: x, y: y, k: k });
  }

  function filters(): Filters {
    return { model: state.filterModel, agent: state.filterAgent, loop: state.filterLoop };
  }

  function isVisible(node: any): boolean {
    return matchesSearch(node, state.search) && passesFilters(node, filters());
  }

  // --- stable, keyed SVG reconciliation -----------------------------------

  function removeMissing<K, E extends Element>(index: Map<K, E>, wanted: Set<K>): void {
    index.forEach((element, key) => {
      if (wanted.has(key)) return;
      element.parentNode?.removeChild(element);
      index.delete(key);
    });
  }

  /**
   * Editorial node card: rounded rect + tier rail (model color as a rail only —
   * never as the sole model indicator), monospace id/sub, and a right-aligned
   * badge for loop/eval markers. Text is left-aligned inside the card.
   */
  function createNodeElement(id: string): SVGGElement {
    var nx = state.nodes[id];
    var node = nx.node;
    var g = el("g", {
      class: "node-group",
      "data-id": id,
      tabindex: "0",
      role: "button",
      "aria-label": "Node " + node.id + ", " + node.agent + ", " + node.model,
    }) as SVGGElement;
    // Entrance animation is a single uniform fade+rise, applied by toggling a
    // class (never an inline style, which `style-src 'self'` blocks). Animation
    // runs once; the class is removed on animationend so retained nodes don't
    // replay it on subsequent updates.
    g.addEventListener("animationend", () => {
      g.classList.remove("is-new");
    });
    // handlers read group.dataset.id at event time so retained elements keep
    // working after graph updates (id never changes for a retained element)
    g.addEventListener("click", () => {
      select(g.dataset.id as string);
    });
    g.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") {
        ev.preventDefault();
        select(g.dataset.id as string);
      }
    });
    var card = el("rect", { class: "node-rect", rx: "10" });
    var rail = el("rect", { class: "node-tier-rail", width: "3", rx: "1.5" });
    var idText = el("text", { class: "node-text-id" });
    var subText = el("text", { class: "node-text-sub" });
    var badgeText = el("text", { class: "node-badge", "text-anchor": "end" });
    g.appendChild(card);
    g.appendChild(rail);
    g.appendChild(idText);
    g.appendChild(subText);
    g.appendChild(badgeText);
    nodeParts.set(g, { rect: card, rail, idText, subText, badgeText });
    return g;
  }

  function updateNodeElement(group: SVGGElement, id: string): void {
    var nx = state.nodes[id];
    var node = nx.node;
    var parts = nodeParts.get(group);
    if (!parts) return;
    var left = nx.x - nx.width / 2;
    parts.rect.setAttribute("x", String(left));
    parts.rect.setAttribute("y", String(nx.y - nx.height / 2));
    parts.rect.setAttribute("width", String(nx.width));
    parts.rect.setAttribute("height", String(nx.height));
    parts.rail.setAttribute("x", String(left + 2));
    parts.rail.setAttribute("y", String(nx.y - nx.height / 2 + 6));
    parts.rail.setAttribute("height", String(nx.height - 12));
    parts.rail.setAttribute("fill", tierColor(node.model));
    parts.idText.setAttribute("x", String(left + 12));
    parts.idText.setAttribute("y", String(nx.y - 8));
    parts.idText.textContent = "";
    parts.idText.appendChild(textNode(node.id));
    parts.subText.setAttribute("x", String(left + 12));
    parts.subText.setAttribute("y", String(nx.y + 12));
    parts.subText.textContent = "";
    parts.subText.appendChild(textNode(node.agent + " · " + node.model));
    parts.badgeText.setAttribute("x", String(left + nx.width - 10));
    parts.badgeText.setAttribute("y", String(nx.y + 12));
    parts.badgeText.textContent = "";
    parts.badgeText.appendChild(
      textNode([node.loop?.enabled ? "↻" : "", node.eval ? "◆" : ""].filter(Boolean).join(" ")),
    );
  }

  function createEdgeElement(edge: PositionedEdge): SVGPathElement {
    // Single shared marker handles the arrowhead; edge elements carry only
    // stable identifying attributes. Geometry updates in updateEdgeElement.
    // Raw endpoint IDs go into data attributes verbatim — setAttribute safely
    // serializes any string, so arbitrary punctuation/whitespace/newline IDs
    // round-trip without escaping (schema allows any string record key).
    var path = el("path", {
      class: "edge",
      "data-from": edge.v,
      "data-to": edge.w,
      "data-dash": "flow",
      "marker-end": "url(#arrow)",
      "stroke-dasharray": "6 6",
    }) as SVGPathElement;
    path.appendChild(textNode(""));
    layers.edges.appendChild(path);
    return path;
  }

  function updateEdgeElement(path: SVGPathElement, edge: PositionedEdge): void {
    var pts = edge.points || [];
    if (pts.length < 2) {
      path.setAttribute("d", "");
      return;
    }
    path.setAttribute("d", curvedPath(pts));
  }

  function reconcileTopology(): void {
    reconcileLanes();
    // Lane show/hide via the SVG visibility attribute — never an inline style,
    // which `style-src 'self'` blocks. No relayout: geometry stays computed.
    layers.lanes.setAttribute("visibility", state.showLanes ? "visible" : "hidden");
    layers.lanes.setAttribute("aria-hidden", state.showLanes ? "false" : "true");

    var wantedNodes = new Set(Object.keys(state.nodes));
    removeMissing(nodeEls, wantedNodes);
    // Append in normalized keyboard/tab order (level, order, then id) so Tab
    // order follows the visual hierarchy regardless of source object order.
    keyboardOrderBy().forEach((id) => {
      if (!wantedNodes.has(id)) return;
      var group = nodeEls.get(id);
      if (!group) {
        group = createNodeElement(id);
        nodeEls.set(id, group);
        group.classList.add("is-new");
      }
      updateNodeElement(group, id);
      // appendChild moves retained groups, preserving identity while restoring
      // normalized keyboard/tab order after live level/order changes. Moving a
      // focused element out of and back into the DOM blurs it (focus loss on
      // every SSE update), so restore focus to the active node after the move.
      layers.nodes.appendChild(group);
      if (group === document.activeElement) group.focus();
    });

    var wantedEdges = new Set(state.edges.map((edge) => edgeKey(edge.v, edge.w)));
    edgeEls.forEach((path, key) => {
      if (wantedEdges.has(key)) return;
      path.parentNode?.removeChild(path);
      edgeEls.delete(key);
    });
    state.edges.forEach((edge) => {
      var key = edgeKey(edge.v, edge.w);
      var path = edgeEls.get(key);
      if (!path) {
        path = createEdgeElement(edge);
        edgeEls.set(key, path);
      }
      updateEdgeElement(path, edge);
    });

    updateViewState();
  }

  function updateViewState(): void {
    var focusId = state.selected || state.hover || state.focus;
    var connected = state.graph ? emphasisIds(state.graph, focusId) : undefined;
    nodeEls.forEach((group, id) => {
      var pn = state.nodes[id];
      group.classList.remove("dim", "emph", "filtered", "selected");
      var vis = pn ? isVisible(pn.node) : false;
      if (!vis) group.classList.add("filtered");
      if (state.selected === id) group.classList.add("selected");
      if (connected) group.classList.add(connected.has(id) ? "emph" : "dim");
      group.dataset.visible = vis ? "1" : "0";
    });
    edgeEls.forEach((path) => {
      path.classList.remove("dim", "emph-conn");
      var adjacent = path.dataset.from === focusId || path.dataset.to === focusId;
      if (connected) path.classList.add(adjacent ? "emph-conn" : "dim");
    });
  }

  function select(id: string, center?: boolean) {
    var was = state.selected;
    state.selected = id === was ? null : id;
    if (state.selected) {
      state.hover = null;
      state.focus = null;
      openDrawer(state.selected);
      if (center) centerOn(state.selected);
    } else {
      closeDrawer();
    }
    updateViewState();
  }

  function centerOn(id: string) {
    var n = state.nodes[id];
    if (!n) return;
    var v = state.view || { x: 0, y: 0, k: 1 };
    setView({ x: svg.clientWidth / 2 - n.x * v.k, y: svg.clientHeight / 2 - n.y * v.k, k: v.k });
    var g = nodeEls.get(id);
    if (g) (g as SVGGraphicsElement).focus();
  }

  function openDrawer(id: string) {
    var node = state.graph!.nodes[id];
    if (!node) return;
    drawer.classList.remove("hidden");
    drawer.setAttribute("aria-hidden", "false");
    drawerTitle.textContent = "";
    drawerTitle.appendChild(textNode(node.id));
    drawerBody.innerHTML = "";
    addField(drawerBody, "Agent", node.agent);
    addField(drawerBody, "Model", node.model);
    if (node.role) addField(drawerBody, "Role", node.role);
    addField(drawerBody, "Objective", node.objective);
    addList(drawerBody, "Dependencies", node.depend_on, (dep) => {
      goToNode(dep);
    });
    addList(drawerBody, "Dependents", node.dependents, (dep) => {
      goToNode(dep);
    });
    addList(drawerBody, "Skills", node.skills);
    addList(drawerBody, "Tools", node.tools);
    if (node.refs && node.refs.length) {
      var rh = heading("References");
      drawerBody.appendChild(rh);
      node.refs.forEach((r: any) => {
        addField(drawerBody, r.path, r.purpose);
      });
    }
    if (node.constraints && node.constraints.length) {
      var ch = heading("Constraints");
      drawerBody.appendChild(ch);
      node.constraints.forEach((c: any) => {
        Object.keys(c).forEach((k) => {
          addField(drawerBody, k, c[k]);
        });
      });
    }
    if (node.loop && node.loop.enabled) {
      var lh = heading("Loop");
      drawerBody.appendChild(lh);
      addField(drawerBody, "Stop when", node.loop.stop_when || "");
      addField(drawerBody, "Max rounds", node.loop.max_rounds);
      if (node.loop.exit_condition) addField(drawerBody, "Exit condition", node.loop.exit_condition);
    }
    addList(drawerBody, "Evidence keys", node.evidence);
    if (node.eval) {
      var eh = heading("Evaluation");
      drawerBody.appendChild(eh);
      addField(drawerBody, "Mode", node.eval.mode);
      addField(drawerBody, "Rubric", node.eval.rubric);
    }
  }

  function heading(t: string) {
    var h = document.createElement("h4");
    h.appendChild(textNode(t));
    return h;
  }

  function addField(container: HTMLElement, label: string, value: unknown) {
    var div = document.createElement("div");
    div.className = "field";
    var k = document.createElement("kbd");
    k.appendChild(textNode(label + ": "));
    div.appendChild(k);
    div.appendChild(textNode(value));
    container.appendChild(div);
  }

  function addList(container: HTMLElement, label: string, items: string[] | undefined, onClick?: (s: string) => void) {
    var h = heading(label);
    container.appendChild(h);
    if (!items || !items.length) {
      var none = document.createElement("div");
      none.className = "field";
      none.appendChild(textNode("—"));
      container.appendChild(none);
      return;
    }
    items.forEach((item) => {
      var span = document.createElement("span");
      span.className = "badge";
      if (onClick) {
        span.classList.add("link");
        span.addEventListener("click", () => {
          onClick(item);
        });
      }
      span.appendChild(textNode(item));
      container.appendChild(span);
    });
  }

  function goToNode(id: string) {
    if (!state.graph!.nodes[id]) return;
    state.selected = id;
    state.hover = null;
    state.focus = null;
    openDrawer(id);
    centerOn(id);
    updateViewState();
  }

  function closeDrawer() {
    drawer.classList.add("hidden");
    drawer.setAttribute("aria-hidden", "true");
  }

  function rebuildHeader() {
    document.getElementById("graph-name")!.textContent = "";
    document.getElementById("graph-name")!.appendChild(textNode(state.graph ? state.graph.name : ""));
    document.getElementById("graph-meta")!.textContent = "";
    if (state.graph) {
      document
        .getElementById("graph-meta")!
        .appendChild(
          textNode(
            state.graph.topology + " · " + state.graph.nodeCount + " nodes · " + state.graph.edgeCount + " edges",
          ),
        );
    }
  }

  function buildFilters() {
    var models = document.getElementById("filter-model") as HTMLSelectElement;
    var agents = document.getElementById("filter-agent") as HTMLSelectElement;
    models.textContent = "";
    agents.textContent = "";
    var mOpt = document.createElement("option");
    mOpt.value = "";
    mOpt.appendChild(textNode("all"));
    models.appendChild(mOpt);
    var aOpt = document.createElement("option");
    aOpt.value = "";
    aOpt.appendChild(textNode("all"));
    agents.appendChild(aOpt);
    var mSet = new Set<string>();
    var aSet = new Set<string>();
    Object.keys(state.graph!.nodes).forEach((id) => {
      var n = state.graph!.nodes[id];
      mSet.add(n.model);
      aSet.add(n.agent);
    });
    TIERS.forEach((t) => {
      if (mSet.has(t)) {
        var o = document.createElement("option");
        o.value = t;
        o.appendChild(textNode(t));
        models.appendChild(o);
      }
    });
    [...aSet].sort().forEach((a) => {
      var o = document.createElement("option");
      o.value = a;
      o.appendChild(textNode(a));
      agents.appendChild(o);
    });
    if (!mSet.has(state.filterModel)) state.filterModel = "";
    if (!aSet.has(state.filterAgent)) state.filterAgent = "";
    models.value = state.filterModel;
    agents.value = state.filterAgent;
    // Clearing stale state changes node visibility after reconcileTopology ran.
    updateViewState();
  }

  function keyboardOrderBy() {
    var arr = Object.keys(state.graph!.nodes).map((id) => ({
      id: id,
      level: state.graph!.nodes[id].level,
      order: state.graph!.nodes[id].order,
    }));
    arr.sort((a, b) => a.level - b.level || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return arr.map((x) => x.id);
  }

  function applyErrorScreen(err: any) {
    document.getElementById("error-screen")!.classList.remove("hidden");
    document.getElementById("error-message")!.textContent = "";
    document.getElementById("error-message")!.appendChild(textNode(err.message || String(err)));
    document.getElementById("error-path")!.textContent = "";
    if (err.path) document.getElementById("error-path")!.appendChild(textNode(err.path));
  }

  function showStale(msg: string) {
    var banner = document.getElementById("stale-banner")!;
    banner.classList.remove("hidden");
    document.getElementById("stale-message")!.textContent = "";
    document.getElementById("stale-message")!.appendChild(textNode(msg));
  }

  function hideStale() {
    document.getElementById("stale-banner")!.classList.add("hidden");
  }

  function applyGraph(graph: ViewerGraph) {
    var prevGraph = state.graph;
    // A node mid-drag snaps to its new layout position: drop drag state and any
    // residual translate before reconcileTopology. Manual nudge never persists.
    dragNodeId = null;
    dragAnchor = null;
    nodeEls.forEach((g) => g.removeAttribute("transform"));
    // Preserve viewport + selection across valid updates; fit only initial load.
    // The retained selection may have been dropped if the node no longer exists.
    var prevSelected = state.selected;
    state.selected = retainedSelection(state.selected, graph);
    state.hover = null;
    state.focus = null;
    state.graph = graph;
    state.nodes = {};
    state.edges = [];
    layout();
    reconcileTopology();
    rebuildHeader();
    buildFilters();
    hideStale();
    document.getElementById("error-screen")!.classList.add("hidden");
    // Refresh drawer for a still-selected node (its details may have changed);
    // close it if the previously selected node was removed by the update.
    if (state.selected) openDrawer(state.selected);
    else if (prevSelected) closeDrawer();
    if (shouldFit(prevGraph)) fitView();
  }

  function applyError(err: any) {
    if (state.graph) {
      showStale("Invalid graph saved — showing last valid version. " + (err.message || ""));
      return;
    }
    applyErrorScreen(err);
  }

  function connectSSE() {
    var es = new EventSource("events?key=" + encodeURIComponent(KEY));
    es.addEventListener("update", (ev) => {
      var data = JSON.parse((ev as MessageEvent).data);
      if (data.type === "graph") applyGraph(data.graph);
      else applyError(data);
    });
    es.onerror = () => {
      // server will reconnect via retry
    };
  }

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
    marker.appendChild(el("path", { class: "arrow-marker", d: "M 0 0 L 10 5 L 0 10 z", fill: "context-stroke" }));
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
    // hidden measurement probe for auto-fitted node sizes — a sibling of the
    // node layer (never a child), so it stays out of node ordering/focus
    probeEl = el("g", { class: "node-probe" });
    viewport.appendChild(probeEl);
  }

  function init() {
    svg = document.getElementById("canvas")!;
    initCanvas();
    drawer = document.getElementById("drawer")!;
    drawerBody = document.getElementById("drawer-body")!;
    drawerTitle = document.getElementById("drawer-title")!;
    searchEl = document.getElementById("search") as HTMLInputElement;

    document.getElementById("fit")!.addEventListener("click", fitView);
    document.getElementById("drawer-close")!.addEventListener("click", () => {
      select(state.selected!);
    });
    document.getElementById("reset-filters")!.addEventListener("click", () => {
      state.filterModel = "";
      state.filterAgent = "";
      state.filterLoop = false;
      (document.getElementById("filter-model") as HTMLSelectElement).value = "";
      (document.getElementById("filter-agent") as HTMLSelectElement).value = "";
      (document.getElementById("filter-loop") as HTMLInputElement).checked = false;
      searchEl.value = "";
      state.search = "";
      updateViewState();
    });
    (document.getElementById("filter-model") as HTMLSelectElement).addEventListener("change", (e) => {
      state.filterModel = (e.target as HTMLSelectElement).value;
      updateViewState();
    });
    (document.getElementById("filter-agent") as HTMLSelectElement).addEventListener("change", (e) => {
      state.filterAgent = (e.target as HTMLSelectElement).value;
      updateViewState();
    });
    (document.getElementById("filter-loop") as HTMLInputElement).addEventListener("change", (e) => {
      state.filterLoop = (e.target as HTMLInputElement).checked;
      updateViewState();
    });
    var lanesToggle = document.getElementById("toggle-lanes") as HTMLInputElement | null;
    if (lanesToggle) {
      state.showLanes = lanesToggle.checked;
      lanesToggle.addEventListener("change", (e) => {
        state.showLanes = (e.target as HTMLInputElement).checked;
        // toggle lane visibility without relayout via the visibility attribute
        layers.lanes.setAttribute("visibility", state.showLanes ? "visible" : "hidden");
        layers.lanes.setAttribute("aria-hidden", state.showLanes ? "false" : "true");
      });
    }
    searchEl.addEventListener("input", (e) => {
      state.search = (e.target as HTMLInputElement).value;
      updateViewState();
    });

    // focus emulates hover for path emphasis (keyboard accessibility); selection
    // locks emphasis, so hover/focus updates only apply when nothing is selected
    svg.addEventListener("focusin", (e) => {
      var target = (e.target as Element).closest("g.node-group");
      if (target) {
        state.focus = (target as HTMLElement).dataset.id as string;
        if (!state.selected) updateViewState();
      }
    });
    svg.addEventListener("focusout", () => {
      state.focus = null;
      if (!state.selected) updateViewState();
    });

    // hover emphasis
    svg.addEventListener("mousemove", (e) => {
      var target = (e.target as Element).closest("g.node-group");
      var id = target ? (target as HTMLElement).dataset.id : null;
      if (id !== state.hover) {
        state.hover = id;
        if (!state.selected) updateViewState();
      }
    });

    // pan + wheel zoom
    svg.addEventListener("mousedown", (e) => {
      if ((e.target as Element).closest("g.node-group")) return;
      mouseAnchor = { x: e.clientX, y: e.clientY, view: state.view || { x: 0, y: 0, k: 1 } };
    });
    // manual nudge: mousedown on a node starts a drag instead of a pan
    svg.addEventListener("mousedown", (e) => {
      var g = (e.target as Element).closest("g.node-group") as HTMLElement | null;
      if (!g) return; // pan handles background
      dragNodeId = g.dataset.id as string;
      var cur = parseTransform(nodeEls.get(dragNodeId));
      dragAnchor = { x: e.clientX, y: e.clientY, tx: cur.tx, ty: cur.ty };
    });
    window.addEventListener("mousemove", (e) => {
      if (dragNodeId && dragAnchor) {
        var g = nodeEls.get(dragNodeId);
        if (g) {
          var k = state.view ? state.view.k : 1;
          var nx = dragAnchor.tx + (e.clientX - dragAnchor.x) / k;
          var ny = dragAnchor.ty + (e.clientY - dragAnchor.y) / k;
          g.setAttribute("transform", `translate(${nx} ${ny})`);
        }
        return;
      }
      if (!mouseAnchor) return;
      var dx = e.clientX - mouseAnchor.x;
      var dy = e.clientY - mouseAnchor.y;
      setView({ x: mouseAnchor.view.x + dx, y: mouseAnchor.view.y + dy, k: mouseAnchor.view.k });
    });
    window.addEventListener("mouseup", () => {
      mouseAnchor = null;
      dragNodeId = null;
      dragAnchor = null;
    });
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      var rect = svg.getBoundingClientRect();
      var cx = e.clientX - rect.left;
      var cy = e.clientY - rect.top;
      zoomBy((e as WheelEvent).deltaY < 0 ? 1.1 : 1 / 1.1, cx, cy);
    });
    svg.addEventListener("dblclick", (e) => {
      if ((e.target as Element).closest("g.node-group")) return;
      fitView();
    });

    // background click clears selection
    svg.addEventListener("click", (e) => {
      if (e.target === svg || e.target === viewport) {
        if (state.selected) {
          state.selected = null;
          closeDrawer();
          updateViewState();
        }
      }
    });

    // keyboard: Escape clears
    window.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") {
        if (state.selected) {
          state.selected = null;
          closeDrawer();
          updateViewState();
        }
      }
    });

    // wheel zoom buttons
    document.addEventListener("keydown", (e) => {
      var k = (e as KeyboardEvent).key;
      if (k === "+" || k === "=") {
        if (document.activeElement === document.body) zoomBy(1.2, svg.clientWidth / 2, svg.clientHeight / 2);
      } else if (k === "-") {
        if (document.activeElement === document.body) zoomBy(1 / 1.2, svg.clientWidth / 2, svg.clientHeight / 2);
      }
    });

    // fetch initial graph
    fetch("api/graph?key=" + encodeURIComponent(KEY))
      .then((r) => r.json())
      .then((data) => {
        if (data.type === "graph") applyGraph(data.graph);
        else applyError(data);
      })
      .catch(applyError)
      .finally(connectSSE);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
