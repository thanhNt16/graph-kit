import type { z } from "zod";
import type { EvalConfigType } from "../schemas/eval.schema.js";
import type { GraphSchema } from "../schemas/graph.schema.js";

export type Graph = z.infer<typeof GraphSchema>;

/**
 * Hard ceiling — larger graphs receive an explicit error, never silent truncation.
 * ponytail: add viewport virtualization or graph clustering only after observed
 * real-world graphs exceed this ceiling.
 */
export const MAX_NODES = 250;

export interface ViewerRef {
  path: string;
  purpose: string;
}

export interface ViewerLoop {
  enabled: boolean;
  stop_when?: string;
  max_rounds: number;
  exit_condition?: string;
}

export interface ViewerNode {
  id: string;
  agent: string;
  model: string;
  role?: string;
  objective: string;
  tools: string[];
  skills: string[];
  refs: ViewerRef[];
  /** Opaque constraint maps, rendered as text. */
  constraints: Array<Record<string, string | number | boolean>>;
  loop: ViewerLoop | null;
  evidence: string[];
  eval?: EvalConfigType;
  /** Forward edges — node IDs this node depends on. */
  depend_on: string[];
  /** Reverse edges — node IDs that depend on this node. */
  dependents: string[];
  /** Longest-path level from any root (deterministic). */
  level: number;
  /** Stable index within the level (insertion order of graph.nodes). */
  order: number;
}

export interface ViewerGraph {
  name: string;
  description?: string;
  topology: string;
  nodeCount: number;
  edgeCount: number;
  nodes: Record<string, ViewerNode>;
}

export interface NormalizeError {
  ok: false;
  code: string;
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

export type NormalizeResult = { ok: true; graph: ViewerGraph } | NormalizeError;

/**
 * Deterministic topological levels: level = longest path from any root.
 * GraphSchema.safeParse already rejected cycles, so the seen-guard is defensive.
 */
export function computeLevels(nodes: Record<string, { depend_on?: string[] }>): Map<string, number> {
  const levels = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const deps = nodes[id]?.depend_on ?? [];
    let lvl = 0;
    if (deps.length > 0) {
      lvl = Math.max(...deps.map((d) => visit(d, seen))) + 1;
    }
    seen.delete(id);
    levels.set(id, lvl);
    return lvl;
  };
  for (const id of Object.keys(nodes)) visit(id, new Set());
  return levels;
}

/**
 * Convert a validated GraphSchema document into a browser-ready view model.
 * Deterministic: same graph → same normalized output. Does not validate the
 * graph (caller must run GraphSchema.safeParse first); it only shapes data.
 */
export function normalizeGraph(graph: Graph): NormalizeResult {
  const nodeIds = Object.keys(graph.nodes);
  if (nodeIds.length > MAX_NODES) {
    return {
      ok: false,
      code: "TOO_LARGE",
      message: `Graph has ${nodeIds.length} nodes; viewer supports at most ${MAX_NODES}.`,
    };
  }

  const levels = computeLevels(graph.nodes);

  // Per-node forward (depend_on) and reverse (dependents) edges.
  const dependents = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const [id, node] of Object.entries(graph.nodes)) {
    for (const dep of node.depend_on) {
      if (dependents.has(dep)) dependents.get(dep)!.push(id);
    }
  }

  // order = insertion index within each level (stable, deterministic).
  const orderInLevel = new Map<string, number>();
  const counter = new Map<number, number>();
  for (const [id] of Object.entries(graph.nodes)) {
    const lvl = levels.get(id) ?? 0;
    const ord = counter.get(lvl) ?? 0;
    counter.set(lvl, ord + 1);
    orderInLevel.set(id, ord);
  }

  const nodes: Record<string, ViewerNode> = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    nodes[id] = {
      id,
      agent: node.agent,
      model: node.model ?? "sonnet",
      role: node.role,
      objective: node.objective,
      tools: node.tools ?? [],
      skills: node.skills ?? [],
      refs: node.refs ?? [],
      constraints: node.constraints ?? [],
      loop: node.loop?.enabled
        ? {
            enabled: true,
            stop_when: node.loop.stop_when,
            max_rounds: node.loop.max_rounds,
            exit_condition: node.loop.exit_condition,
          }
        : null,
      evidence: node.evidence ?? [],
      eval: node.eval,
      depend_on: node.depend_on ?? [],
      dependents: dependents.get(id) ?? [],
      level: levels.get(id) ?? 0,
      order: orderInLevel.get(id) ?? 0,
    };
  }

  const edgeCount = Object.values(nodes).reduce((n, node) => n + node.depend_on.length, 0);

  return {
    ok: true,
    graph: {
      name: graph.metadata.name,
      description: graph.metadata.description,
      topology: graph.topology,
      nodeCount: nodeIds.length,
      edgeCount,
      nodes,
    },
  };
}
