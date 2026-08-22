(() => {
  // src/viewer/view.ts
  function edgeKey(from, to) {
    return from.length + ":" + from + to.length + ":" + to;
  }
  function routeIds(graph, from, to) {
    const nodes = new Set;
    const edges = new Set;
    if (!graph.nodes[from] || !graph.nodes[to])
      return { nodes, edges };
    if (from === to) {
      nodes.add(from);
      return { nodes, edges };
    }
    const prev = new Map;
    const queue = [from];
    const seen = new Set([from]);
    while (queue.length) {
      const cur2 = queue.shift();
      if (cur2 === to)
        break;
      for (const next of graph.nodes[cur2].dependents) {
        if (!graph.nodes[next])
          continue;
        if (seen.has(next))
          continue;
        seen.add(next);
        prev.set(next, cur2);
        queue.push(next);
      }
    }
    if (!prev.has(to))
      return { nodes, edges };
    nodes.add(to);
    let cur = to;
    while (cur !== from) {
      const p = prev.get(cur);
      if (p === undefined)
        break;
      edges.add(edgeKey(p, cur));
      nodes.add(p);
      cur = p;
    }
    return { nodes, edges };
  }
  function matchesSearch(node, query) {
    if (!query)
      return true;
    const q = query.toLowerCase();
    const hay = [node.id, node.agent, node.objective].concat(node.skills || []).concat(node.tools || []).join(`
`).toLowerCase();
    return hay.indexOf(q) !== -1;
  }
  function passesFilters(node, f) {
    if (f.model && node.model !== f.model)
      return false;
    if (f.agent && node.agent !== f.agent)
      return false;
    if (f.loop && !node.loop?.enabled)
      return false;
    return true;
  }
  function emphasisIds(graph, focusId) {
    if (!focusId)
      return null;
    const node = graph.nodes[focusId];
    if (!node)
      return null;
    const conn = new Set([focusId]);
    for (const d of node.depend_on)
      conn.add(d);
    for (const d of node.dependents)
      conn.add(d);
    return conn;
  }
  function retainedSelection(prevSelected, graph) {
    return prevSelected && graph.nodes[prevSelected] ? prevSelected : null;
  }
  function shouldFit(prevGraph) {
    return prevGraph === null;
  }

  // src/viewer/app.ts
  (() => {
    var KEY = new URLSearchParams(location.search).get("key") || "";
    var NODE_W = 208;
    var NODE_H = 64;
    var nodeSizes = new Map;
    var probeEl = null;
    var TIERS = ["opus", "sonnet", "haiku", "fable"];
    var COLOR = {
      opus: "var(--tier-opus)",
      sonnet: "var(--tier-sonnet)",
      haiku: "var(--tier-haiku)",
      fable: "var(--tier-fable)",
      default: "var(--tier-default)"
    };
    var state = {
      graph: null,
      nodes: {},
      edges: [],
      selected: null,
      hover: null,
      focus: null,
      search: "",
      filterModel: "",
      filterAgent: "",
      filterLoop: false,
      showLanes: true,
      view: null,
      minK: 0.05,
      maxK: 4
    };
    var svg;
    var viewport;
    var layers;
    var nodeEls = new Map;
    var edgeEls = new Map;
    var laneEls = new Map;
    var nodeParts = new WeakMap;
    var drawer;
    var drawerBody;
    var drawerTitle;
    var searchEl;
    var lastDrawerNode = null;
    var mouseAnchor = null;
    var dragNodeId = null;
    var dragAnchor = null;
    var prevDragDx = 0;
    var prevDragDy = 0;
    var edgeHitEls = new WeakMap;
    var edgeHover = null;
    var traceFrom = null;
    var traceTo = null;
    var traceRoute = null;
    function el(tag, props, children) {
      var n = document.createElementNS("http://www.w3.org/2000/svg", tag);
      if (props)
        for (var k in props)
          n.setAttribute(k, props[k]);
      (children || []).forEach((c) => {
        n.appendChild(c);
      });
      return n;
    }
    function textNode(content) {
      return document.createTextNode(content == null ? "" : String(content));
    }
    function tierColor(model) {
      return COLOR[model] || COLOR.default;
    }
    function nodeTitle(node) {
      return node.id + `
` + node.agent + " · " + node.model;
    }
    function nodeContentKey(node) {
      return [node.id, node.agent, node.model, node.loop?.enabled ? "loop" : "", node.eval ? "eval" : ""].join("~");
    }
    function nodeSizeFor(node) {
      var key = nodeContentKey(node);
      var cached = nodeSizes.get(node.id);
      if (cached && cached.key === key) {
        return { width: cached.width, height: cached.height };
      }
      var probe = probeEl;
      if (!probe) {
        return { width: NODE_W, height: NODE_H };
      }
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
      var g = new dagre.graphlib.Graph;
      g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 70, marginx: 40, marginy: 40 });
      g.setDefaultEdgeLabel(() => ({}));
      Object.keys(state.graph.nodes).forEach((id) => {
        var size = nodeSizeFor(state.graph.nodes[id]);
        g.setNode(id, { width: size.width, height: size.height, label: nodeTitle(state.graph.nodes[id]) });
      });
      Object.keys(state.graph.nodes).forEach((id) => {
        state.graph.nodes[id].depend_on.forEach((dep) => {
          if (state.graph.nodes[dep])
            g.setEdge(dep, id);
        });
      });
      dagre.layout(g);
      state.nodes = {};
      state.edges = [];
      Object.keys(state.graph.nodes).forEach((id) => {
        var p = g.node(id);
        state.nodes[id] = {
          x: p.x,
          y: p.y,
          width: p.width || NODE_W,
          height: p.height || NODE_H,
          node: state.graph.nodes[id]
        };
      });
      g.edges().forEach((e) => {
        var label = g.edge(e) || {};
        state.edges.push({ v: e.v, w: e.w, points: label.points });
      });
    }
    function graphBounds() {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      Object.keys(state.nodes).forEach((id) => {
        var n = state.nodes[id];
        minX = Math.min(minX, n.x - n.width / 2);
        maxX = Math.max(maxX, n.x + n.width / 2);
        minY = Math.min(minY, n.y - n.height / 2);
        maxY = Math.max(maxY, n.y + n.height / 2);
      });
      if (!isFinite(minX))
        return { x: 0, y: 0, w: 600, h: 400 };
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    function edgeKey2(from, to) {
      return from.length + ":" + from + to.length + ":" + to;
    }
    function curvedPath(points) {
      var first = points[0];
      var last = points[points.length - 1];
      var midY = (first.y + last.y) / 2;
      return "M " + first.x + "," + first.y + " C " + first.x + "," + midY + " " + last.x + "," + midY + " " + last.x + "," + last.y;
    }
    function laneBounds(level) {
      var nodes = Object.values(state.nodes).filter((entry) => entry.node.level === level);
      var bounds = graphBounds();
      var minY = Math.min(...nodes.map((entry) => entry.y - entry.height / 2)) - 34;
      var maxY = Math.max(...nodes.map((entry) => entry.y + entry.height / 2)) + 34;
      return { x: bounds.x - 28, y: minY, width: bounds.w + 56, height: maxY - minY };
    }
    function reconcileLanes() {
      var levels = new Set(Object.values(state.nodes).map((entry) => entry.node.level));
      removeMissing(laneEls, levels);
      [...levels].sort((a, b) => a - b).forEach((level) => {
        var group = laneEls.get(level);
        if (!group) {
          group = el("g", { class: "lane-group", "data-level": String(level) });
          group.appendChild(el("rect", { class: level % 2 ? "lane alt" : "lane" }));
          var label = el("text", { class: "lane-label" });
          group.appendChild(label);
          laneEls.set(level, group);
          layers.lanes.appendChild(group);
        }
        var b = laneBounds(level);
        var rect = group.querySelector("rect.lane");
        rect.setAttribute("x", String(b.x));
        rect.setAttribute("y", String(b.y));
        rect.setAttribute("width", String(b.width));
        rect.setAttribute("height", String(b.height));
        var label2 = group.querySelector("text.lane-label");
        label2.setAttribute("x", String(b.x + 12));
        label2.setAttribute("y", String(b.y + 18));
        label2.textContent = "Phase " + level;
      });
    }
    function parseTransform(g) {
      if (!g)
        return { tx: 0, ty: 0 };
      var t = g.getAttribute("transform") || "";
      var m = t.match(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)/);
      return m ? { tx: parseFloat(m[1]), ty: parseFloat(m[2]) } : { tx: 0, ty: 0 };
    }
    function setView(v) {
      state.view = v;
      if (viewport)
        viewport.setAttribute("transform", "translate(" + v.x + "," + v.y + ") scale(" + v.k + ")");
    }
    function fitView() {
      var b = graphBounds();
      var { clientWidth: vw, clientHeight: vh } = svg;
      if (!vw)
        vw = window.innerWidth;
      if (!vh)
        vh = window.innerHeight;
      var k = Math.min(vw / b.w, vh / b.h, 1.2);
      k = Math.max(k, state.minK);
      setView({ x: vw / 2 - (b.x + b.w / 2) * k, y: vh / 2 - (b.y + b.h / 2) * k, k });
    }
    function zoomBy(factor, cx, cy) {
      var v = state.view || { x: 0, y: 0, k: 1 };
      var k = Math.min(Math.max(v.k * factor, state.minK), state.maxK);
      var ratio = k / v.k;
      var x = cx - (cx - v.x) * ratio;
      var y = cy - (cy - v.y) * ratio;
      setView({ x, y, k });
    }
    function filters() {
      return { model: state.filterModel, agent: state.filterAgent, loop: state.filterLoop };
    }
    function isVisible(node) {
      return matchesSearch(node, state.search) && passesFilters(node, filters());
    }
    function removeMissing(index, wanted) {
      index.forEach((element, key) => {
        if (wanted.has(key))
          return;
        element.parentNode?.removeChild(element);
        index.delete(key);
      });
    }
    function createNodeElement(id) {
      var nx = state.nodes[id];
      var node = nx.node;
      var g = el("g", {
        class: "node-group",
        "data-id": id,
        tabindex: "0",
        role: "button",
        "aria-label": "Node " + node.id + ", " + node.agent + ", " + node.model
      });
      g.addEventListener("animationend", () => {
        g.classList.remove("is-new");
      });
      g.addEventListener("click", (ev) => {
        if (ev.shiftKey)
          return;
        select(g.dataset.id);
      });
      g.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          select(g.dataset.id);
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
    function updateNodeElement(group, id) {
      var nx = state.nodes[id];
      var node = nx.node;
      var parts = nodeParts.get(group);
      if (!parts)
        return;
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
      parts.badgeText.appendChild(textNode([node.loop?.enabled ? "↻" : "", node.eval ? "◆" : ""].filter(Boolean).join(" ")));
    }
    function createEdgeElement(edge) {
      var path = el("path", {
        class: "edge",
        "data-from": edge.v,
        "data-to": edge.w,
        "data-dash": "flow",
        "marker-end": "url(#arrow)",
        "stroke-dasharray": "6 6"
      });
      path.appendChild(textNode(""));
      var hit = el("path", {
        class: "edge-hit",
        "data-from": edge.v,
        "data-to": edge.w,
        "aria-hidden": "true",
        tabindex: "-1",
        "pointer-events": "stroke"
      });
      hit.appendChild(textNode(""));
      layers.edges.appendChild(hit);
      edgeHitEls.set(path, hit);
      hit.addEventListener("pointerenter", () => {
        edgeHover = { from: edge.v, to: edge.w };
        if (!state.selected)
          updateViewState();
      });
      hit.addEventListener("pointerleave", () => {
        edgeHover = null;
        if (!state.selected)
          updateViewState();
      });
      hit.addEventListener("click", () => {
        select(edge.w);
      });
      layers.edges.appendChild(path);
      return path;
    }
    function updateEdgeElement(path, edge) {
      var pts = edge.points || [];
      if (pts.length < 2) {
        path.setAttribute("d", "");
        var hit = edgeHitEls.get(path);
        if (hit)
          hit.setAttribute("d", "");
        return;
      }
      var d = curvedPath(pts);
      path.setAttribute("d", d);
      var hit = edgeHitEls.get(path);
      if (hit)
        hit.setAttribute("d", d);
    }
    function rerouteIncidentEdges(id, dx, dy) {
      state.edges.forEach((edge) => {
        if (edge.v !== id && edge.w !== id)
          return;
        if (!edge.points || edge.points.length < 2)
          return;
        var pts = edge.points;
        if (edge.v === id) {
          pts[0] = { x: pts[0].x + dx, y: pts[0].y + dy };
        } else {
          pts[pts.length - 1] = { x: pts[pts.length - 1].x + dx, y: pts[pts.length - 1].y + dy };
        }
        var path = edgeEls.get(edgeKey2(edge.v, edge.w));
        if (path)
          updateEdgeElement(path, edge);
      });
    }
    function reconcileTopology() {
      reconcileLanes();
      layers.lanes.setAttribute("visibility", state.showLanes ? "visible" : "hidden");
      layers.lanes.setAttribute("aria-hidden", state.showLanes ? "false" : "true");
      var wantedNodes = new Set(Object.keys(state.nodes));
      removeMissing(nodeEls, wantedNodes);
      keyboardOrderBy().forEach((id) => {
        if (!wantedNodes.has(id))
          return;
        var group = nodeEls.get(id);
        if (!group) {
          group = createNodeElement(id);
          nodeEls.set(id, group);
          group.classList.add("is-new");
        }
        updateNodeElement(group, id);
        var wasFocused = group === document.activeElement;
        layers.nodes.appendChild(group);
        if (wasFocused)
          group.focus();
      });
      var wantedEdges = new Set(state.edges.map((edge) => edgeKey2(edge.v, edge.w)));
      edgeEls.forEach((path, key) => {
        if (wantedEdges.has(key))
          return;
        var hit = edgeHitEls.get(path);
        if (hit)
          hit.parentNode?.removeChild(hit);
        edgeHitEls.delete(path);
        path.parentNode?.removeChild(path);
        edgeEls.delete(key);
      });
      state.edges.forEach((edge) => {
        var key = edgeKey2(edge.v, edge.w);
        var path = edgeEls.get(key);
        if (!path) {
          path = createEdgeElement(edge);
          edgeEls.set(key, path);
        }
        updateEdgeElement(path, edge);
      });
      updateViewState();
    }
    function selfHealTrace() {
      if (!state.graph)
        return;
      if (traceFrom && !state.graph.nodes[traceFrom]) {
        traceFrom = null;
        traceTo = null;
        traceRoute = null;
        return;
      }
      if (traceTo && !state.graph.nodes[traceTo]) {
        traceFrom = null;
        traceTo = null;
        traceRoute = null;
      }
    }
    function clearTrace() {
      if (!traceRoute && !traceFrom)
        return;
      traceFrom = null;
      traceTo = null;
      traceRoute = null;
      updateViewState();
    }
    function updateViewState() {
      selfHealTrace();
      var focusId = state.selected || state.hover || edgeHover?.from || state.focus;
      var connected = state.graph ? emphasisIds(state.graph, focusId) : undefined;
      nodeEls.forEach((group, id) => {
        var pn = state.nodes[id];
        group.classList.remove("dim", "emph", "filtered", "selected", "route");
        var vis = pn ? isVisible(pn.node) : false;
        if (!vis)
          group.classList.add("filtered");
        if (state.selected === id)
          group.classList.add("selected");
        if (connected)
          group.classList.add(connected.has(id) ? "emph" : "dim");
        group.dataset.visible = vis ? "1" : "0";
        if (traceRoute && traceRoute.nodes.has(id))
          group.classList.add("route");
      });
      edgeEls.forEach((path) => {
        path.classList.remove("dim", "emph-conn", "route");
        var hit = edgeHitEls.get(path);
        if (hit)
          hit.classList.remove("route");
        var adjacent = path.dataset.from === focusId || path.dataset.to === focusId;
        if (connected)
          path.classList.add(adjacent ? "emph-conn" : "dim");
        if (traceRoute && traceRoute.edges.has(edgeKey2(path.dataset.from, path.dataset.to))) {
          path.classList.add("route");
          if (hit)
            hit.classList.add("route");
        }
      });
    }
    function select(id, center) {
      var was = state.selected;
      state.selected = id === was ? null : id;
      if (state.selected) {
        state.hover = null;
        state.focus = null;
        openDrawer(state.selected);
        if (center)
          centerOn(state.selected);
      } else {
        closeDrawer();
      }
      updateViewState();
    }
    function centerOn(id) {
      var n = state.nodes[id];
      if (!n)
        return;
      var v = state.view || { x: 0, y: 0, k: 1 };
      setView({ x: svg.clientWidth / 2 - n.x * v.k, y: svg.clientHeight / 2 - n.y * v.k, k: v.k });
      var g = nodeEls.get(id);
      if (g)
        g.focus();
    }
    function openDrawer(id) {
      var node = state.graph.nodes[id];
      if (!node)
        return;
      lastDrawerNode = id;
      drawer.classList.remove("hidden");
      drawer.setAttribute("aria-hidden", "false");
      drawer.setAttribute("role", "dialog");
      drawer.setAttribute("aria-modal", "true");
      drawer.setAttribute("aria-label", "Details for " + node.id);
      drawerTitle.tabIndex = -1;
      drawerTitle.focus();
      drawerTitle.textContent = "";
      drawerTitle.appendChild(textNode(node.id));
      drawerBody.innerHTML = "";
      addField(drawerBody, "Agent", node.agent);
      addField(drawerBody, "Model", node.model);
      if (node.role)
        addField(drawerBody, "Role", node.role);
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
        node.refs.forEach((r) => {
          addField(drawerBody, r.path, r.purpose);
        });
      }
      if (node.constraints && node.constraints.length) {
        var ch = heading("Constraints");
        drawerBody.appendChild(ch);
        node.constraints.forEach((c) => {
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
        if (node.loop.exit_condition)
          addField(drawerBody, "Exit condition", node.loop.exit_condition);
      }
      addList(drawerBody, "Evidence keys", node.evidence);
      if (node.eval) {
        var eh = heading("Evaluation");
        drawerBody.appendChild(eh);
        addField(drawerBody, "Mode", node.eval.mode);
        addField(drawerBody, "Rubric", node.eval.rubric);
      }
    }
    function heading(t) {
      var h = document.createElement("h4");
      h.appendChild(textNode(t));
      return h;
    }
    function addField(container, label, value) {
      var div = document.createElement("div");
      div.className = "field";
      var k = document.createElement("kbd");
      k.appendChild(textNode(label + ": "));
      div.appendChild(k);
      div.appendChild(textNode(value));
      container.appendChild(div);
    }
    function addList(container, label, items, onClick) {
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
    function goToNode(id) {
      if (!state.graph.nodes[id])
        return;
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
      if (lastDrawerNode) {
        var returnTo = nodeEls.get(lastDrawerNode);
        lastDrawerNode = null;
        if (returnTo)
          returnTo.focus();
      }
    }
    function rebuildHeader() {
      document.getElementById("graph-name").textContent = "";
      document.getElementById("graph-name").appendChild(textNode(state.graph ? state.graph.name : ""));
      document.getElementById("graph-meta").textContent = "";
      if (state.graph) {
        document.getElementById("graph-meta").appendChild(textNode(state.graph.topology + " · " + state.graph.nodeCount + " nodes · " + state.graph.edgeCount + " edges"));
      }
    }
    function buildFilters() {
      var models = document.getElementById("filter-model");
      var agents = document.getElementById("filter-agent");
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
      var mSet = new Set;
      var aSet = new Set;
      Object.keys(state.graph.nodes).forEach((id) => {
        var n = state.graph.nodes[id];
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
      if (!mSet.has(state.filterModel))
        state.filterModel = "";
      if (!aSet.has(state.filterAgent))
        state.filterAgent = "";
      models.value = state.filterModel;
      agents.value = state.filterAgent;
      updateViewState();
    }
    function keyboardOrderBy() {
      var arr = Object.keys(state.graph.nodes).map((id) => ({
        id,
        level: state.graph.nodes[id].level,
        order: state.graph.nodes[id].order
      }));
      arr.sort((a, b) => a.level - b.level || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return arr.map((x) => x.id);
    }
    function applyErrorScreen(err) {
      document.getElementById("error-screen").classList.remove("hidden");
      document.getElementById("error-message").textContent = "";
      document.getElementById("error-message").appendChild(textNode(err.message || String(err)));
      document.getElementById("error-path").textContent = "";
      if (err.path)
        document.getElementById("error-path").appendChild(textNode(err.path));
    }
    function showStale(msg) {
      var banner = document.getElementById("stale-banner");
      banner.classList.remove("hidden");
      document.getElementById("stale-message").textContent = "";
      document.getElementById("stale-message").appendChild(textNode(msg));
    }
    function hideStale() {
      document.getElementById("stale-banner").classList.add("hidden");
    }
    function applyGraph(graph) {
      var prevGraph = state.graph;
      dragNodeId = null;
      dragAnchor = null;
      prevDragDx = 0;
      prevDragDy = 0;
      nodeEls.forEach((g) => g.removeAttribute("transform"));
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
      document.getElementById("error-screen").classList.add("hidden");
      if (state.selected)
        openDrawer(state.selected);
      else if (prevSelected)
        closeDrawer();
      if (shouldFit(prevGraph))
        fitView();
    }
    function applyError(err) {
      if (state.graph) {
        showStale("Invalid graph saved — showing last valid version. " + (err.message || ""));
        return;
      }
      applyErrorScreen(err);
    }
    function connectSSE() {
      var es = new EventSource("events?key=" + encodeURIComponent(KEY));
      es.addEventListener("update", (ev) => {
        var data = JSON.parse(ev.data);
        if (data.type === "graph")
          applyGraph(data.graph);
        else
          applyError(data);
      });
      es.onerror = () => {};
    }
    function initCanvas() {
      var defs = el("defs");
      var marker = el("marker", {
        id: "arrow",
        viewBox: "0 0 10 10",
        refX: "9",
        refY: "5",
        markerWidth: "7",
        markerHeight: "7",
        orient: "auto-start-reverse"
      });
      marker.appendChild(el("path", { class: "arrow-marker", d: "M 0 0 L 10 5 L 0 10 z", fill: "context-stroke" }));
      defs.appendChild(marker);
      svg.appendChild(defs);
      viewport = el("g", { class: "viewport" });
      layers = {
        lanes: el("g", { class: "lane-layer" }),
        edges: el("g", { class: "edge-layer" }),
        nodes: el("g", { class: "node-layer" })
      };
      viewport.appendChild(layers.lanes);
      viewport.appendChild(layers.edges);
      viewport.appendChild(layers.nodes);
      svg.appendChild(viewport);
      probeEl = el("g", { class: "node-probe" });
      viewport.appendChild(probeEl);
    }
    function init() {
      svg = document.getElementById("canvas");
      initCanvas();
      drawer = document.getElementById("drawer");
      drawerBody = document.getElementById("drawer-body");
      drawerTitle = document.getElementById("drawer-title");
      searchEl = document.getElementById("search");
      document.getElementById("fit").addEventListener("click", fitView);
      document.getElementById("drawer-close").addEventListener("click", () => {
        select(state.selected);
      });
      document.getElementById("reset-filters").addEventListener("click", () => {
        state.filterModel = "";
        state.filterAgent = "";
        state.filterLoop = false;
        document.getElementById("filter-model").value = "";
        document.getElementById("filter-agent").value = "";
        document.getElementById("filter-loop").checked = false;
        searchEl.value = "";
        state.search = "";
        updateViewState();
      });
      document.getElementById("filter-model").addEventListener("change", (e) => {
        state.filterModel = e.target.value;
        updateViewState();
      });
      document.getElementById("filter-agent").addEventListener("change", (e) => {
        state.filterAgent = e.target.value;
        updateViewState();
      });
      document.getElementById("filter-loop").addEventListener("change", (e) => {
        state.filterLoop = e.target.checked;
        updateViewState();
      });
      var lanesToggle = document.getElementById("toggle-lanes");
      if (lanesToggle) {
        state.showLanes = lanesToggle.checked;
        lanesToggle.addEventListener("change", (e) => {
          state.showLanes = e.target.checked;
          layers.lanes.setAttribute("visibility", state.showLanes ? "visible" : "hidden");
          layers.lanes.setAttribute("aria-hidden", state.showLanes ? "false" : "true");
        });
      }
      searchEl.addEventListener("input", (e) => {
        state.search = e.target.value;
        updateViewState();
      });
      svg.addEventListener("focusin", (e) => {
        var target = e.target.closest("g.node-group");
        if (target) {
          state.focus = target.dataset.id;
          if (!state.selected)
            updateViewState();
        }
      });
      svg.addEventListener("focusout", () => {
        state.focus = null;
        edgeHover = null;
        if (!state.selected)
          updateViewState();
      });
      svg.addEventListener("mousemove", (e) => {
        var target = e.target.closest("g.node-group");
        var id = target ? target.dataset.id : null;
        if (id !== state.hover) {
          state.hover = id;
          if (!state.selected)
            updateViewState();
        }
      });
      svg.addEventListener("mousemove", (e) => {
        var hit = e.target.closest("path.edge-hit");
        var cur = hit ? { from: hit.getAttribute("data-from"), to: hit.getAttribute("data-to") } : null;
        if (cur?.from !== edgeHover?.from || cur?.to !== edgeHover?.to) {
          edgeHover = cur;
          if (!state.selected)
            updateViewState();
        }
      });
      svg.addEventListener("mousedown", (e) => {
        if (e.target.closest("g.node-group"))
          return;
        mouseAnchor = { x: e.clientX, y: e.clientY, view: state.view || { x: 0, y: 0, k: 1 } };
      });
      svg.addEventListener("mousedown", (e) => {
        var g = e.target.closest("g.node-group");
        if (!g)
          return;
        dragNodeId = g.dataset.id;
        var cur = parseTransform(nodeEls.get(dragNodeId));
        dragAnchor = { x: e.clientX, y: e.clientY, tx: cur.tx, ty: cur.ty };
        prevDragDx = 0;
        prevDragDy = 0;
      });
      window.addEventListener("mousemove", (e) => {
        if (dragNodeId && dragAnchor) {
          var g = nodeEls.get(dragNodeId);
          if (g) {
            var k = state.view ? state.view.k : 1;
            var dx = (e.clientX - dragAnchor.x) / k;
            var dy = (e.clientY - dragAnchor.y) / k;
            g.setAttribute("transform", `translate(${dragAnchor.tx + dx} ${dragAnchor.ty + dy})`);
            rerouteIncidentEdges(dragNodeId, dx - prevDragDx, dy - prevDragDy);
            prevDragDx = dx;
            prevDragDy = dy;
          }
          return;
        }
        if (!mouseAnchor)
          return;
        var dx = e.clientX - mouseAnchor.x;
        var dy = e.clientY - mouseAnchor.y;
        setView({ x: mouseAnchor.view.x + dx, y: mouseAnchor.view.y + dy, k: mouseAnchor.view.k });
      });
      window.addEventListener("mouseup", () => {
        mouseAnchor = null;
        dragNodeId = null;
        dragAnchor = null;
        prevDragDx = 0;
        prevDragDy = 0;
      });
      svg.addEventListener("wheel", (e) => {
        e.preventDefault();
        var rect = svg.getBoundingClientRect();
        var cx = e.clientX - rect.left;
        var cy = e.clientY - rect.top;
        zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, cx, cy);
      });
      svg.addEventListener("dblclick", (e) => {
        if (e.target.closest("g.node-group"))
          return;
        fitView();
      });
      svg.addEventListener("click", (e) => {
        if (e.target === svg || e.target === viewport) {
          if (state.selected) {
            state.selected = null;
            closeDrawer();
            updateViewState();
          }
        }
      });
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          if (state.selected) {
            state.selected = null;
            closeDrawer();
            updateViewState();
          }
          if (traceRoute || traceFrom)
            clearTrace();
        }
      });
      svg.addEventListener("click", (e) => {
        if (!e.shiftKey) {
          if (traceRoute || traceFrom)
            clearTrace();
          return;
        }
        var g = e.target.closest("g.node-group");
        if (!g)
          return;
        var id = g.dataset.id;
        if (!state.graph.nodes[id])
          return;
        if (traceRoute)
          clearTrace();
        if (traceFrom === null) {
          traceFrom = id;
          return;
        }
        if (id === traceFrom) {
          clearTrace();
          return;
        }
        traceRoute = routeIds(state.graph, traceFrom, id);
        traceTo = id;
        updateViewState();
      });
      drawer.addEventListener("keydown", (e) => {
        if (e.key !== "Tab")
          return;
        if (drawer.classList.contains("hidden"))
          return;
        var focusables = drawer.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!focusables.length) {
          e.preventDefault();
          return;
        }
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === drawerTitle)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
      document.addEventListener("keydown", (e) => {
        var k = e.key;
        var ae = document.activeElement;
        var onGraph = !ae || ae === document.body || ae === svg || ae && ae.classList && ae.classList.contains("node-group");
        if (k === "+" || k === "=") {
          if (onGraph)
            zoomBy(1.2, svg.clientWidth / 2, svg.clientHeight / 2);
        } else if (k === "-") {
          if (onGraph)
            zoomBy(1 / 1.2, svg.clientWidth / 2, svg.clientHeight / 2);
        }
      });
      document.addEventListener("keydown", (e) => {
        var k = e.key;
        if (k !== "ArrowRight" && k !== "ArrowLeft" && k !== "ArrowUp" && k !== "ArrowDown")
          return;
        var from = e.target.closest?.("g.node-group");
        if (!from)
          return;
        var fromId = from.dataset.id;
        var cur = state.nodes[fromId];
        if (!cur)
          return;
        var dirX = k === "ArrowRight" ? 1 : k === "ArrowLeft" ? -1 : 0;
        var dirY = k === "ArrowDown" ? 1 : k === "ArrowUp" ? -1 : 0;
        var best = null;
        nodeEls.forEach((group, id) => {
          if (id === fromId)
            return;
          var n = state.nodes[id];
          if (!n || group.dataset.visible !== "1")
            return;
          var dx = n.x - cur.x;
          var dy = n.y - cur.y;
          if (dirX !== 0 && dx * dirX < 0)
            return;
          if (dirY !== 0 && dy * dirY < 0)
            return;
          var primary = dirY !== 0 ? Math.abs(dy) : Math.abs(dx);
          var cross = dirY !== 0 ? Math.abs(dx) : Math.abs(dy);
          var score = primary * (1 + cross * 0.01);
          if (!best || score < best.score)
            best = { id, score };
        });
        if (best) {
          e.preventDefault();
          var target = nodeEls.get(best.id);
          if (target)
            target.focus();
        }
      });
      fetch("api/graph?key=" + encodeURIComponent(KEY)).then((r) => r.json()).then((data) => {
        if (data.type === "graph")
          applyGraph(data.graph);
        else
          applyError(data);
      }).catch(applyError).finally(connectSSE);
    }
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", init);
    else
      init();
  })();
})();
