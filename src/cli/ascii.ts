import { readFileSync } from "node:fs";
import YAML from "yaml";

interface GraphNode {
  agent: string;
  model?: string;
  objective?: string;
  depend_on?: string[];
  evidence?: string[];
  role?: string;
  loop?: { enabled?: boolean; stop_when?: string; max_rounds?: number };
}

interface Graph {
  metadata: { name: string; description?: string };
  topology: string;
  nodes: Record<string, GraphNode>;
  evidence?: { required_keys?: string[] };
  limits?: Record<string, number>;
  topology_config?: Record<string, unknown>;
}

// Pure ASCII charset — no Unicode, no emoji. Works in every terminal/markdown/editor.
const TIER_TAG: Record<string, string> = {
  opus: "O",
  sonnet: "S",
  haiku: "H",
  fable: "F",
};

/**
 * Box a single line of text: +-- text --+
 * Width is padded to the given target.
 */
function boxLine(text: string, width: number): string {
  const pad = width - text.length - 2; // 2 for borders
  if (pad < 0) return `| ${text} |`;
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return `|${" ".repeat(left)}${text}${" ".repeat(right)}|`;
}

/**
 * Build a box for a node: multi-line with tier tag, id, agent.
 * Returns array of lines (without surrounding newlines).
 */
function nodeBox(id: string, node: GraphNode): string[] {
  const tag = TIER_TAG[node.model ?? "sonnet"] ?? "S";
  const loopTag = node.loop?.enabled ? " loop" : "";
  const roleTag = node.role ? ` (${node.role})` : "";
  const title = `[${tag}] ${id}${roleTag}${loopTag}`;
  const sub = `${node.agent} · ${node.model ?? "sonnet"}`;
  const ev = node.evidence?.length ? `evidence: ${node.evidence.join(", ")}` : "";

  const width = Math.max(title.length, sub.length, ev.length, 14) + 4;
  const top = `+${"-".repeat(width - 2)}+`;
  const lines = [top, boxLine(title, width), boxLine(sub, width)];
  if (ev) lines.push(boxLine(ev, width));
  lines.push(top);
  return lines;
}

/**
 * Compute column centers (0-based, relative to content after "  " prefix)
 * for side-by-side boxes of given widths separated by 3-space gaps.
 */
function columnCenters(widths: number[]): number[] {
  const gap = 3;
  const centers: number[] = [];
  let x = 0;
  for (const w of widths) {
    centers.push(x + Math.floor(w / 2));
    x += w + gap;
  }
  return centers;
}

/** Place a char at `pos` in a line, padding as needed. */
function placeChar(line: string, pos: number, ch: string): string {
  if (line.length <= pos) line = line.padEnd(pos + 1);
  return line.substring(0, pos) + ch + line.substring(pos + 1);
}

/** Build horizontal bar connecting column centers with `+` and `-`. */
function horizontalBar(centers: number[]): string {
  if (centers.length === 0) return "";
  const sorted = [...centers].sort((a, b) => a - b);
  const first = sorted[0];
  let bar = placeChar("", first, "+");
  for (let i = 1; i < sorted.length; i++) {
    bar = bar.padEnd(sorted[i]);
    for (let j = sorted[i - 1] + 1; j < sorted[i]; j++) bar = placeChar(bar, j, "-");
    bar = placeChar(bar, sorted[i], "+");
  }
  return bar;
}

/**
 * Fan-out: 1 parent → N children.
 * centers: column center positions of each child box (0-based after "  " prefix).
 */
function fanOutConnector(centers: number[]): string[] {
  if (centers.length <= 1) return ["    |", "    v"];
  const stemPos = centers[0] + Math.floor((centers[centers.length - 1] - centers[0]) / 2);
  const bar = horizontalBar(centers);
  const drops = centers.reduce((acc, c) => [placeChar(acc[0], c, "|"), placeChar(acc[1], c, "v")], ["", ""]);
  return [`${" ".repeat(stemPos + 2)}|`, bar, drops[0], drops[1]];
}

/**
 * Fan-in: N parents → 1 child.
 * centers: column center positions of each parent box (0-based after "  " prefix).
 */
function fanInConnector(centers: number[]): string[] {
  if (centers.length <= 1) return ["    |", "    v"];
  const stemPos = centers[0] + Math.floor((centers[centers.length - 1] - centers[0]) / 2);
  const bar = horizontalBar(centers);
  const rises = centers.reduce((acc, c) => [placeChar(acc[0], c, "|"), placeChar(acc[1], c, "^")], ["", ""]);
  return [rises[0], rises[1], bar, `${" ".repeat(stemPos + 2)}|`, `${" ".repeat(stemPos)}    v`];
}

/**
 * Render a graph.yaml as a pure-ASCII diagram.
 * Deterministic layout — no model, no rendering pipeline. Instant.
 */
export function renderAscii(graphFile: string): string {
  const raw = readFileSync(graphFile, "utf-8");
  const graph = YAML.parse(raw) as Graph;
  const nodes = graph.nodes;
  const nodeIds = Object.keys(nodes);

  // Topological levels: level = longest path from any root
  const levels = new Map<string, number>();
  const computeLevel = (id: string, seen: Set<string>): number => {
    if (levels.has(id)) return levels.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = nodes[id]?.depend_on ?? [];
    if (deps.length === 0) {
      levels.set(id, 0);
      return 0;
    }
    const maxDep = Math.max(...deps.map((d) => computeLevel(d, seen)));
    const lvl = maxDep + 1;
    levels.set(id, lvl);
    return lvl;
  };
  for (const id of nodeIds) computeLevel(id, new Set());

  const maxLevel = Math.max(...levels.values());
  const byLevel: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const id of nodeIds) byLevel[levels.get(id)!].push(id);

  const out: string[] = [];
  out.push("");
  out.push(
    `+-- ${graph.metadata.name} (${graph.topology}) ${"-".repeat(Math.max(0, 40 - graph.metadata.name.length - graph.topology.length))}+`,
  );
  if (graph.metadata.description) out.push(`| ${graph.metadata.description}`);
  out.push("");

  // Render each level
  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const ids = byLevel[lvl];

    // Side-by-side if multiple nodes at same level
    if (ids.length > 1) {
      // Render each node box, interleave lines side by side
      const boxes = ids.map((id) => nodeBox(id, nodes[id]));
      const maxLines = Math.max(...boxes.map((b) => b.length));
      const boxWidths = boxes.map((b) => b[0].length);
      for (let li = 0; li < maxLines; li++) {
        let line = "  ";
        for (let bi = 0; bi < boxes.length; bi++) {
          const bl = boxes[bi][li] ?? " ".repeat(boxWidths[bi]);
          line += `${bl}   `;
        }
        out.push(line.trimEnd());
      }
    } else {
      // Single node — indent and center
      const box = nodeBox(ids[0], nodes[0] ? nodes[ids[0]] : nodes[ids[0]]);
      for (const bl of box) out.push(`  ${bl}`);
    }

    // Connector to next level
    if (lvl < maxLevel) {
      const nextIds = byLevel[lvl + 1];
      // Compute actual box widths for the side-by-side level to get column centers
      const nextBoxes = nextIds.map((id) => nodeBox(id, nodes[id]));
      const nextWidths = nextBoxes.map((b) => b[0].length);
      const curBoxes = ids.map((id) => nodeBox(id, nodes[id]));
      const curWidths = curBoxes.map((b) => b[0].length);

      if (ids.length === 1 && nextIds.length > 1) {
        const centers = columnCenters(nextWidths);
        for (const c of fanOutConnector(centers)) out.push(`  ${c}`);
      } else if (ids.length > 1 && nextIds.length <= 1) {
        const centers = columnCenters(curWidths);
        for (const c of fanInConnector(centers)) out.push(`  ${c}`);
      } else {
        out.push("    |");
        out.push("    v");
      }
    }
  }

  out.push("");
  out.push(`+-- evidence: [${graph.evidence?.required_keys?.join(", ") ?? ""}] ${"-".repeat(8)}+`);
  out.push("");
  out.push("Legend: [O]=opus  [S]=sonnet  [H]=haiku  [F]=fable  (role)=node role  loop=internal loop");
  out.push("");

  return out.join("\n");
}
