/* GraphKit viewer — browser runtime. All graph values are inserted as text
   nodes, never innerHTML. Reads the normalized graph from the server.
   Bundled to claude/viewer/app.js + cursor/viewer/app.js by scripts/build-viewer.sh.
   Pure search/filter/emphasis/state rules live in view.ts and are unit-tested. */

import type { ViewerGraph } from "./normalize.js";
import { emphasisIds, type Filters, matchesSearch, passesFilters, retainedSelection, shouldFit } from "./view.js";

(() => {
  var KEY = new URLSearchParams(location.search).get("key") || "";
  var NODE_W = 180;
  var NODE_H = 54;
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
  var nodeParts = new WeakMap<SVGGElement, { rect: any; idText: any; subText: any }>();
  var edgeArrows = new WeakMap<SVGPathElement, SVGPathElement>();
  var drawer: HTMLElement;
  var drawerBody: HTMLElement;
  var drawerTitle: HTMLElement;
  var searchEl: HTMLInputElement;
  var mouseAnchor: { x: number; y: number; view: { x: number; y: number; k: number } } | null = null;
  var keyboardOrder: string[] = [];

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

  function esc(id: string) {
    return String(id).replace(/[^a-zA-Z0-9_-]/g, () => "_");
  }

  function tierColor(model: string) {
    return COLOR[model as keyof typeof COLOR] || COLOR.default;
  }

  function nodeTitle(node: any) {
    return node.id + "\n" + node.agent + " · " + node.model;
  }

  function layout() {
    var g = new (dagre as any).graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 70, marginx: 40, marginy: 40 });
    g.setDefaultEdgeLabel(() => ({}));
    Object.keys(state.graph!.nodes).forEach((id) => {
      g.setNode(id, { width: NODE_W, height: NODE_H, label: nodeTitle(state.graph!.nodes[id]) });
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
    return from + "\n" + to;
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

  function edgeArrowD(pts: Array<{ x: number; y: number }>): string | null {
    var last = pts[pts.length - 1];
    var prev = pts[pts.length - 2];
    if (!last || !prev) return null;
    var ang = Math.atan2(last.y - prev.y, last.x - prev.x);
    var ax = last.x - 6 * Math.cos(ang),
      ay = last.y - 6 * Math.sin(ang);
    return (
      "M " +
      last.x +
      "," +
      last.y +
      " L " +
      (ax + 3 * Math.cos(ang + 2.4)) +
      "," +
      (ay + 3 * Math.sin(ang + 2.4)) +
      " L " +
      (ax + 3 * Math.cos(ang - 2.4)) +
      "," +
      (ay + 3 * Math.sin(ang - 2.4)) +
      " Z"
    );
  }

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
    var rect = el("rect", { class: "node-rect", rx: "8" });
    var idText = el("text", { class: "node-text-id", "text-anchor": "middle" });
    var subText = el("text", { class: "node-text-sub", "text-anchor": "middle" });
    g.appendChild(rect);
    g.appendChild(idText);
    g.appendChild(subText);
    nodeParts.set(g, { rect, idText, subText });
    return g;
  }

  function updateNodeElement(group: SVGGElement, id: string): void {
    var nx = state.nodes[id];
    var node = nx.node;
    var parts = nodeParts.get(group);
    if (!parts) return;
    parts.rect.setAttribute("x", String(nx.x - nx.width / 2));
    parts.rect.setAttribute("y", String(nx.y - nx.height / 2));
    parts.rect.setAttribute("width", String(nx.width));
    parts.rect.setAttribute("height", String(nx.height));
    parts.rect.setAttribute("stroke", tierColor(node.model));
    parts.idText.setAttribute("x", String(nx.x));
    parts.idText.setAttribute("y", String(nx.y - 4));
    parts.idText.textContent = "";
    parts.idText.appendChild(textNode(node.id + (node.loop && node.loop.enabled ? " ↻" : "")));
    parts.subText.setAttribute("x", String(nx.x));
    parts.subText.setAttribute("y", String(nx.y + 14));
    parts.subText.textContent = "";
    parts.subText.appendChild(textNode(node.agent + " · " + node.model));
  }

  function createEdgeElement(edge: PositionedEdge): SVGPathElement {
    var path = el("path", {
      class: "edge",
      "data-from": esc(edge.v),
      "data-to": esc(edge.w),
    }) as SVGPathElement;
    path.appendChild(textNode(""));
    var arr = el("path", {
      class: "edge-arrow",
      "data-from": esc(edge.v),
      "data-to": esc(edge.w),
    }) as SVGPathElement;
    arr.appendChild(textNode(""));
    edgeArrows.set(path, arr);
    return path;
  }

  function updateEdgeElement(path: SVGPathElement, edge: PositionedEdge): void {
    var pts = edge.points || [];
    var d = "";
    if (pts.length >= 2) {
      d = "M " + pts[0].x + "," + pts[0].y;
      for (var i = 1; i < pts.length; i++) d += " L " + pts[i].x + "," + pts[i].y;
    }
    path.setAttribute("d", d);
    var arr = edgeArrows.get(path);
    if (arr) {
      var ad = edgeArrowD(pts);
      arr.setAttribute("d", ad || "");
    }
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
      var arr = edgeArrows.get(path);
      if (arr) arr.classList.remove("dim", "emph-conn");
      if (connected && arr) arr.classList.add(adjacent ? "emph-conn" : "dim");
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
    var mSet: Record<string, boolean> = {};
    var aSet: Record<string, boolean> = {};
    Object.keys(state.graph!.nodes).forEach((id) => {
      var n = state.graph!.nodes[id];
      mSet[n.model] = true;
      aSet[n.agent] = true;
    });
    TIERS.forEach((t) => {
      if (mSet[t]) {
        var o = document.createElement("option");
        o.value = t;
        o.appendChild(textNode(t));
        models.appendChild(o);
      }
    });
    Object.keys(aSet)
      .sort()
      .forEach((a) => {
        var o = document.createElement("option");
        o.value = a;
        o.appendChild(textNode(a));
        agents.appendChild(o);
      });
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
    keyboardOrder = keyboardOrderBy();
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
    searchEl.addEventListener("input", (e) => {
      state.search = (e.target as HTMLInputElement).value;
      updateViewState();
    });

    // focus emulates hover for path emphasis (keyboard accessibility)
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
    window.addEventListener("mousemove", (e) => {
      if (!mouseAnchor) return;
      var dx = e.clientX - mouseAnchor.x;
      var dy = e.clientY - mouseAnchor.y;
      setView({ x: mouseAnchor.view.x + dx, y: mouseAnchor.view.y + dy, k: mouseAnchor.view.k });
    });
    window.addEventListener("mouseup", () => {
      mouseAnchor = null;
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
      });

    connectSSE();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
