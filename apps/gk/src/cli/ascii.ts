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

const MODEL_ICON: Record<string, string> = {
  opus: "🟣",
  sonnet: "🔵",
  haiku: "🟢",
  fable: "🟠",
};

/**
 * Render a graph.yaml as an ASCII diagram.
 * Pure code — no model, no rendering pipeline. Instant.
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
    if (seen.has(id)) return 0; // cycle guard
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

  // Group nodes by level
  const maxLevel = Math.max(...levels.values());
  const byLevel: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const id of nodeIds) byLevel[levels.get(id)!].push(id);

  // Reverse adjacency: who depends on each node (children)
  const children = new Map<string, string[]>();
  for (const id of nodeIds) children.set(id, []);
  for (const id of nodeIds) {
    for (const dep of nodes[id].depend_on ?? []) {
      if (children.has(dep)) children.get(dep)!.push(id);
    }
  }

  const lines: string[] = [];
  lines.push(`\n  ┌─ ${graph.metadata.name} (${graph.topology}) ──────────────────────`);
  if (graph.metadata.description) lines.push(`  │ ${graph.metadata.description}`);
  lines.push(`  │`);

  // Render each level
  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const ids = byLevel[lvl];

    // Draw nodes at this level
    for (const id of ids) {
      const node = nodes[id];
      const icon = MODEL_ICON[node.model ?? "sonnet"] ?? "⚪";
      const loopTag = node.loop?.enabled ? ` ↻${node.loop.max_rounds ?? 3}` : "";
      const roleTag = node.role ? ` [${node.role}]` : "";
      const depTag = (node.depend_on?.length ?? 0) > 0 ? `  ← ${(node.depend_on ?? []).join(", ")}` : "";

      lines.push(`  │`);
      lines.push(`  │  ${icon} ${id}${roleTag}${loopTag}`);
      lines.push(`  │     ${node.agent} · ${node.model ?? "sonnet"}${depTag}`);
      if (node.evidence?.length) {
        lines.push(`  │     evidence: ${node.evidence.join(", ")}`);
      }
    }

    // Draw connector to next level
    if (lvl < maxLevel) {
      const nextIds = byLevel[lvl + 1];
      if (ids.length === 1 && nextIds.length > 1) {
        lines.push(`  │`);
        lines.push(`  │  └──┬${nextIds.map(() => "──").join("┐")}`);
        lines.push(`  │     │ fan-out (${nextIds.length} parallel)`);
      } else if (ids.length > 1 && nextIds.length === 1) {
        lines.push(`  │`);
        lines.push(`  │  ┌──┴${ids.map(() => "──").join("┘")} fan-in`);
      } else {
        lines.push(`  │`);
        lines.push(`  │       │`);
      }
    }
  }

  lines.push(`  │`);
  lines.push(`  └─ evidence: [${graph.evidence?.required_keys?.join(", ") ?? ""}] ───`);

  // Legend
  lines.push(``);
  lines.push(`  Legend: 🟣opus  🔵sonnet  🟢haiku  🟠fable  ↻loop  [role]`);
  lines.push(``);

  return lines.join("\n");
}
