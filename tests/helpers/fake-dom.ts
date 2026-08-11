/**
 * Minimal dependency-free fake DOM/browser harness that EXECUTES the bundled
 * viewer (claude/viewer/app.js) inside node:vm. Purpose-built for the viewer
 * browser-behavior tests — this is not a general DOM implementation.
 *
 * Supports exactly what app.js touches: getElementById, createElement(NS),
 * createTextNode, classList, dataset, attributes, querySelector(All) for the
 * viewer's own class/attr patterns, addEventListener/dispatch, textContent,
 * innerHTML-as-clear, fetch, EventSource, dagre, and window/document globals.
 */

import { createContext, runInContext } from "node:vm";

export class FakeText {
  nodeType = 3;
  parentNode: FakeEl | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
  set textContent(v: string) {
    this.data = String(v);
  }
}

export class FakeClassList {
  private set = new Set<string>();
  add(...c: string[]) {
    c.forEach((x) => {
      this.set.add(x);
    });
  }
  remove(...c: string[]) {
    c.forEach((x) => {
      this.set.delete(x);
    });
  }
  contains(c: string) {
    return this.set.has(c);
  }
  values() {
    return [...this.set];
  }
}

function textOf(n: FakeEl | FakeText): string {
  if (n instanceof FakeText) return n.data;
  return n.children.map(textOf).join("");
}

const SELECTOR_RE = /^([a-zA-Z]+)?(?:\.([\w-]+))?((?:\s*\[[\w-]+="[^"]*"\])*)$/;

export class FakeEl {
  nodeType = 1;
  parentNode: FakeEl | null = null;
  children: Array<FakeEl | FakeText> = [];
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList: FakeClassList;
  listeners: Record<string, Array<(ev: any) => void>> = {};
  clientWidth = 1000;
  clientHeight = 800;
  ownerDocument: any = null;
  value = "";
  checked = false;
  id = "";
  style: Record<string, string> = {};

  constructor(
    public tagName: string,
    public isSVG = false,
  ) {
    this.classList = new FakeClassList(this);
  }

  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
    if (k === "style") {
      this.style = {};
      String(v)
        .split(";")
        .filter(Boolean)
        .forEach((decl) => {
          const idx = decl.indexOf(":");
          if (idx > 0) this.style[decl.slice(0, idx).trim()] = decl.slice(idx + 1).trim();
        });
    }
    if (k === "class") {
      this.classList.remove(...this.classList.values());
      String(v)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => {
          this.classList.add(c);
        });
    }
    if (k.startsWith("data-")) this.dataset[k.slice(5)] = String(v);
  }

  getAttribute(k: string): string | undefined {
    return this.attrs[k];
  }

  appendChild(c: FakeEl | FakeText) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }

  removeChild(c: FakeEl | FakeText) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    return c;
  }

  addEventListener(t: string, fn: (ev: any) => void) {
    const list = this.listeners[t] || [];
    list.push(fn);
    this.listeners[t] = list;
  }

  dispatch(type: string, init?: Record<string, unknown>) {
    const ev = Object.assign(
      { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} },
      init ?? {},
    );
    for (const fn of this.listeners[type] || []) {
      fn(ev);
    }
    return ev;
  }

  matches(sel: string): boolean {
    const m = SELECTOR_RE.exec(sel);
    if (!m) return false;
    const [, tag, cls, attrPart] = m;
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    if (cls && !this.classList.contains(cls)) return false;
    if (attrPart) {
      const attrs = [...attrPart.matchAll(/\[([\w-]+)="([^"]*)"\]/g)];
      for (const a of attrs) {
        const key = a[1].startsWith("data-") ? a[1].slice(5) : a[1];
        if ((this.dataset[key] ?? this.attrs[a[1]]) !== a[2]) return false;
      }
    }
    return true;
  }

  closest(sel: string): FakeEl | null {
    let n: FakeEl | null = this;
    while (n) {
      if (n.matches(sel)) return n;
      n = n.parentNode;
    }
    return null;
  }

  querySelector(sel: string): FakeEl | null {
    const found = this.querySelectorAll(sel);
    return found[0] ?? null;
  }

  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl) => {
      for (const c of n.children) {
        if (c instanceof FakeEl) {
          if (c.matches(sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }

  set textContent(v: string) {
    this.children = [new FakeText(String(v))];
  }

  get textContent(): string {
    return textOf(this);
  }

  get innerHTML() {
    return "";
  }

  set innerHTML(v: string) {
    if (v === "") this.children = [];
  }

  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      right: this.clientWidth,
      bottom: this.clientHeight,
      width: this.clientWidth,
      height: this.clientHeight,
    };
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
}

/** Build the document object app.js expects. */
function makeDocument() {
  const ids: Record<string, FakeEl> = {};
  const reg = (id: string, tag: string, className = "") => {
    const e = new FakeEl(tag);
    e.id = id;
    if (className) e.setAttribute("class", className);
    ids[id] = e;
    return e;
  };
  reg("canvas", "svg");
  reg("drawer", "aside", "drawer hidden");
  reg("drawer-title", "span");
  reg("drawer-body", "div");
  reg("drawer-close", "button");
  reg("fit", "button");
  reg("reset-filters", "button");
  reg("filter-model", "select");
  reg("filter-agent", "select");
  reg("filter-loop", "input");
  reg("toggle-lanes", "input");
  ids["toggle-lanes"].checked = true;
  reg("search", "input");
  reg("stale-banner", "div", "banner hidden");
  reg("stale-message", "span");
  reg("error-screen", "div", "error-screen hidden");
  reg("error-message", "p");
  reg("error-path", "p");
  reg("graph-name", "span");
  reg("graph-meta", "span");
  let doc: any;
  const body = new FakeEl("body");
  const owner = (e: FakeEl) => {
    e.ownerDocument = doc;
    return e;
  };
  for (const id of Object.keys(ids)) owner(ids[id]);
  doc = {
    readyState: "complete",
    body,
    activeElement: body,
    getElementById: (id: string) => ids[id] ?? null,
    createElement: (tag: string) => owner(new FakeEl(tag)),
    createElementNS: (_ns: string, tag: string) => owner(new FakeEl(tag, true)),
    createTextNode: (d: unknown) => new FakeText(String(d == null ? "" : d)),
    addEventListener: () => {},
    ids,
  };
  return doc;
}

export interface ViewerHarness {
  doc: ReturnType<typeof makeDocument>;
  es: FakeEventSource[];
  getEl(id: string): FakeEl;
  nodeGroup(id: string): FakeEl | null;
  viewport(): FakeEl | null;
  edge(from: string, to: string): FakeEl | null;
  lane(level: number): FakeEl | null;
  emitUpdate(payload: unknown): void;
  setSearch(v: string): void;
  setModelFilter(v: string): void;
  clickNode(id: string): void;
  focusNode(id: string): void;
  blurNode(id: string): void;
  hoverNode(id: string): void;
  zoomWheel(deltaY: number): void;
  viewportTransform(): string | null;
  drawerVisible(): boolean;
  drawerText(): string;
  staleVisible(): boolean;
  textContent(id: string): string;
}

class FakeEventSource {
  handlers: Record<string, Array<(ev: any) => void>> = {};
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener(t: string, fn: (ev: any) => void) {
    const list = this.handlers[t] || [];
    list.push(fn);
    this.handlers[t] = list;
  }
  emit(type: string, data: string) {
    for (const fn of this.handlers[type] || []) {
      fn({ type, data });
    }
  }
}

class FakeGraph {
  nodes: Record<string, any> = {};
  edgesArr: Array<{ v: string; w: string; points?: Array<{ x: number; y: number }> }> = [];
  setGraph(_g: any) {}
  setDefaultEdgeLabel(_fn: () => any) {}
  setNode(id: string, p: any) {
    this.nodes[id] = { ...p };
  }
  setEdge(v: string, w: string) {
    this.edgesArr.push({ v, w });
  }
  node(id: string) {
    const n = this.nodes[id];
    return n ? { ...n } : undefined;
  }
  edges() {
    return this.edgesArr;
  }
  edge(e: any) {
    const rec = this.edgesArr.find((x) => x.v === e.v && x.w === e.w);
    return rec ? { points: rec.points } : {};
  }
}

const fakeDagre = {
  graphlib: { Graph: FakeGraph },
  layout(g: FakeGraph) {
    // Fake layout for deterministic test geometry only — production dagre
    // already ranks nodes by dependency level (TB, ranksep 70). Nodes are
    // placed monotonically so each lane's bounds come out of its own level's
    // nodes in tests. Lane geometry itself derives from ViewerNode.level, not
    // from this y-inference.
    Object.keys(g.nodes).forEach((id, i) => {
      g.nodes[id].x = 160 + i * 220;
      g.nodes[id].y = 120 + i * 150;
    });
    g.edgesArr.forEach((e) => {
      const a = g.node(e.v);
      const b = g.node(e.w);
      if (a && b)
        e.points = [
          { x: a.x, y: a.y + 27 },
          { x: b.x, y: b.y - 27 },
        ];
    });
  },
};

/**
 * Execute the bundled viewer inside a fresh vm context and return a controller.
 * `initialGraph` is what the initial fetch resolves to.
 */
export function createViewerHarness(appJs: string, initialGraph: unknown): ViewerHarness {
  const doc = makeDocument();
  const esInstances: FakeEventSource[] = [];
  const win = { innerWidth: 1200, innerHeight: 800, addEventListener: () => {} };
  const sandbox: Record<string, unknown> = {
    document: doc,
    window: win,
    location: { search: "?key=testkey", href: "http://127.0.0.1/?key=testkey" },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ type: "graph", graph: initialGraph }) }),
    EventSource: class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        esInstances.push(this);
      }
    },
    dagre: fakeDagre,
    URLSearchParams: (globalThis as any).URLSearchParams,
    console,
  };
  createContext(sandbox);
  runInContext(appJs, sandbox);

  const harness: ViewerHarness = {
    doc,
    es: esInstances,
    getEl: (id) => doc.ids[id],
    nodeGroup: (id) => {
      const vps = doc.ids.canvas.querySelectorAll("g.viewport");
      return (vps[vps.length - 1] || doc.ids.canvas).querySelector(`[data-id="${id}"]`) ?? null;
    },
    viewport: () => doc.ids.canvas.querySelector("g.viewport"),
    edge: (from, to) => doc.ids.canvas.querySelector(`path.edge[data-from="${from}"][data-to="${to}"]`),
    lane: (level) => doc.ids.canvas.querySelector(`[data-level="${level}"]`),
    emitUpdate: (payload) => {
      for (const es of esInstances) es.emit("update", JSON.stringify(payload));
    },
    setSearch: (v) => {
      const s = doc.ids.search;
      s.value = v;
      s.dispatch("input", { target: s });
    },
    setModelFilter: (v) => {
      const m = doc.ids["filter-model"];
      m.value = v;
      m.dispatch("change", { target: m });
    },
    clickNode: (id) => {
      const g = harness.nodeGroup(id);
      if (g) g.dispatch("click");
    },
    focusNode: (id) => {
      const g = harness.nodeGroup(id);
      if (g) doc.ids.canvas.dispatch("focusin", { target: g });
    },
    blurNode: () => {
      doc.ids.canvas.dispatch("focusout", { target: doc.ids.canvas });
    },
    hoverNode: (id) => {
      const g = harness.nodeGroup(id);
      if (g) doc.ids.canvas.dispatch("mousemove", { target: g });
    },
    zoomWheel: (deltaY) => {
      doc.ids.canvas.dispatch("wheel", { deltaY, clientX: 500, clientY: 400 });
    },
    viewportTransform: () => {
      const vps = doc.ids.canvas.querySelectorAll("g.viewport");
      const vp = vps[vps.length - 1];
      return vp ? (vp.getAttribute("transform") ?? null) : null;
    },
    drawerVisible: () => {
      const d = doc.ids.drawer;
      return !d.classList.contains("hidden") && d.getAttribute("aria-hidden") !== "true";
    },
    drawerText: () => doc.ids["drawer-body"].textContent,
    staleVisible: () => !doc.ids["stale-banner"].classList.contains("hidden"),
    textContent: (id) => doc.ids[id].textContent,
  };
  return harness;
}

/** Await a couple of microtask ticks so the initial fetch applies the graph. */
export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}
