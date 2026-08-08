import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  const lines = [
    top,
    boxLine(title, width),
    boxLine(sub, width),
  ];
  if (ev) lines.push(boxLine(ev, width));
  lines.push(top);
  return lines;
}

/**
 * Center-connect a parent box to N child boxes using pure ASCII.
 */
function fanOutConnector(childCount: number): string[] {
  if (childCount <= 1) return ["    |", "    v"];
  const width = childCount * 4;
  let line = "    +";
  for (let i = 1; i < childCount; i++) line += "---+";
  return ["    |", line, `    fan-out (${childCount} parallel)`];
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
  out.push(`+-- ${graph.metadata.name} (${graph.topology}) ${"-".repeat(Math.max(0, 40 - graph.metadata.name.length - graph.topology.length))}+`);
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
          line += bl + "   ";
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
      if (ids.length === 1 && nextIds.length > 1) {
        for (const c of fanOutConnector(nextIds.length)) out.push(`  ${c}`);
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
