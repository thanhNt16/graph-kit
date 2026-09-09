import { createRequire } from "node:module";
import type { Graph } from "../compiler/validate.js";

type GraphNode = Graph["nodes"][string];

// dagre's re-exported graphlib defaults its generics to `any`; pin the layout
// shapes we rely on so the render path stays honestly typed.
interface LayoutNode {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface LayoutEdge {
  points?: { x: number; y: number }[];
}

const TIER_COLOR: Record<string, string> = {
  opus: "#a371f7",
  sonnet: "#58a6ff",
  haiku: "#3fb950",
  fable: "#f0883e",
};

// F6: dagre is heavy and only `gk graph svg` renders, but every command that
// pulls in ./graph.js pays for a top-level import of it. Load on first render
// instead. Kept synchronous on purpose: the svg subcommand calls renderSvg()
// from a non-async action, so a dynamic `await import()` (which would change
// the exported signature) is not an option here.
type DagreModule = typeof import("@dagrejs/dagre").default;
const lazyRequire = createRequire(import.meta.url);

export function renderSvg(graph: Graph): string {
  const dagre = lazyRequire("@dagrejs/dagre") as DagreModule;
  const nodes = graph.nodes || {};

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 50, ranksep: 60, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const [id, node] of Object.entries(nodes)) {
    const label = `${id}\n${node.agent || ""} · ${node.model || "sonnet"}`;
    g.setNode(id, { width: 180, height: 50, label });
  }

  for (const [id, node] of Object.entries(nodes)) {
    for (const dep of node.depend_on || []) {
      if (nodes[dep]) g.setEdge(dep, id);
    }
  }

  dagre.layout(g);

  const svgNodes = Object.keys(nodes)
    .map((id) => {
      const n = g.node(id) as LayoutNode;
      const node: GraphNode = nodes[id];
      const color = TIER_COLOR[node.model || "sonnet"] || "#58a6ff";
      const lines = n.label.split("\n");
      return `
    <g transform="translate(${n.x - n.width / 2},${n.y - n.height / 2})">
      <rect width="${n.width}" height="${n.height}" rx="8" fill="#0d1117" stroke="${color}" stroke-width="2"/>
      <text x="${n.width / 2}" y="20" text-anchor="middle" fill="${color}" font-family="monospace" font-size="13" font-weight="bold">${lines[0] || id}</text>
      <text x="${n.width / 2}" y="38" text-anchor="middle" fill="#8b949e" font-family="monospace" font-size="11">${lines[1] || ""}</text>
    </g>`;
    })
    .join("");

  const svgEdges = g
    .edges()
    .map((e) => {
      const edge = g.edge(e) as LayoutEdge;
      if (!edge.points || edge.points.length < 2) return "";
      const path = edge.points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`).join(" ");
      return `\n    <path d="${path}" fill="none" stroke="#30363d" stroke-width="1.5"/>`;
    })
    .join("");

  const graphObj = g.graph();
  const width = (graphObj.width || 600) + 80;
  const height = (graphObj.height || 400) + 80;

  const title = `${graph.metadata?.name || "graph"} (${graph.topology})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}" style="background:#0a0e14">
  <title>${title}</title>
  <rect width="100%" height="100%" fill="#0a0e14"/>
  <text x="${width / 2}" y="25" text-anchor="middle" fill="#e6edf3" font-family="sans-serif" font-size="16" font-weight="bold">${title}</text>
  ${svgEdges}
  ${svgNodes}
</svg>`;
}
