// THE wave/level computation for graph-kit. Three copies of this logic used to
// live in graph.ts (Kahn BFS for the dispatch payload), validate.ts
// (memoized-DFS longest path for loop span closure), and ascii.ts (a
// near-verbatim twin of validate.ts's for layering) — three places for "what
// is a wave" to drift. Both formulations now live here, next to the Graph type:
//
//   computeWaves  — Kahn's algorithm; wave w = nodes whose depend_on are all in
//                   earlier waves. Intra-wave order follows node declaration.
//                   On a DAG the wave INDEX equals the longest-path level, but
//                   intra-wave ORDER differs from the DFS partition, and the
//                   `graph waves` payload order is a pinned contract consumed
//                   by /gk:execute and /gk:visualize — so graph.ts keeps this
//                   one, and the golden waves test pins the order.
//   computeLevels — memoized-DFS longest path (what validate.ts and ascii.ts
//                   both hand-rolled). Cycles yield a deterministic 0 for the
//                   nodes involved, matching the historical silent behavior;
//                   use computeWaves().unresolved when a cycle must be LOUD.
import type { Graph } from "./validate.js";

export interface WavePartition {
  waves: string[][];
  /** nodes never scheduled — non-empty only when the dependency graph has a cycle or a dangling depend_on */
  unresolved: string[];
}

export function computeWaves(nodes: Graph["nodes"]): WavePartition {
  const ids = Object.keys(nodes);
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    const deps = nodes[id]?.depend_on ?? [];
    // Count ALL deps: a dangling depend_on (target not a node) can never be
    // satisfied, so the node lands in `unresolved` — the caller decides
    // whether that is loud (graph waves → WAVES_INCOMPLETE) or tolerated.
    remaining.set(id, deps.length);
    for (const d of deps) {
      if (!Object.hasOwn(nodes, d)) continue;
      const list = dependents.get(d);
      if (list) list.push(id);
      else dependents.set(d, [id]);
    }
  }

  const waves: string[][] = [];
  const scheduled = new Set<string>();
  const declaration = new Map(ids.map((id, i) => [id, i] as const));
  let frontier = ids.filter((id) => (remaining.get(id) ?? 0) === 0);
  while (frontier.length > 0) {
    waves.push(frontier);
    for (const id of frontier) scheduled.add(id);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of dependents.get(id) ?? []) {
        const left = (remaining.get(dep) ?? 0) - 1;
        remaining.set(dep, left);
        if (left === 0) next.push(dep);
      }
    }
    // The reference implementation filtered the full id list each round, so
    // every wave came out in node-declaration order — restore that here, since
    // discovery order above depends on which dep happened to complete first.
    frontier = next.sort((a, b) => declaration.get(a)! - declaration.get(b)!);
  }
  const unresolved = ids.filter((id) => !scheduled.has(id));
  return { waves, unresolved };
}

/** Longest-path level per node (0 for roots). Cycles resolve to a level based
 *  on the DFS entry point — deterministic, historically preserved. */
export function computeLevels(nodes: Graph["nodes"]): Map<string, number> {
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const memo = levels.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = nodes[id]?.depend_on ?? [];
    let max = -1;
    for (const d of deps) {
      if (!Object.hasOwn(nodes, d)) continue;
      max = Math.max(max, visit(d));
    }
    visiting.delete(id);
    const level = max + 1;
    levels.set(id, level);
    return level;
  };
  for (const id of Object.keys(nodes)) visit(id);
  return levels;
}

// ---------------------------------------------------------------------------
// Execution planning: the curator-interleave + cadence computation that
// `gk graph waves` (and round-5 `gk run plan`) project onto the wave partition.
// Extracted verbatim from the inline planner in cli/commands/graph.ts so the
// cadence rules are unit-testable directly instead of only through the CLI.

export interface PlanWave {
  wave: number;
  parallel: boolean;
  curator?: boolean;
  nodes: PlanNode[];
}

export interface PlanNode {
  id: string;
  agent?: string;
  model: string;
  objective: string;
  tools: string[];
  skills: string[];
  refs: Graph["nodes"][string]["refs"];
  depend_on: string[];
  loop: Graph["nodes"][string]["loop"] | null;
  evidence: string[];
  advisor: Graph["nodes"][string]["advisor"] | null;
  fan_out: Graph["nodes"][string]["fan_out"] | null;
  hooks: NonNullable<Graph["hooks"]>["on_node_complete"];
}

export interface ExecutionPlan {
  graph?: string;
  topology: string;
  total_waves: number;
  total_nodes: number;
  waves: PlanWave[];
  evidence_required: string[];
  on_graph_complete: NonNullable<Graph["hooks"]>["on_graph_complete"];
  /** present only for memory-augmented graphs with a live curator node */
  memory?: {
    curator_node: string;
    cadence: string;
    every: number;
    recall_topk: number;
    expire_policy: string;
    null_intervention_allowed: boolean;
  };
}

/**
 * Project a graph onto dispatch waves. Action nodes go through the shared
 * Kahn partition; a memory-augmented graph's curator node is pulled out of
 * scheduling and re-inserted as its own interleave waves at the configured
 * cadence (the execute-path equivalent of memory-augmented.workflow.js's
 * wrappedAgent, which only runs under the Workflow tool). Throws-free: an
 * unresolvable dependency graph yields `unresolved` — the CALLER decides
 * whether that is loud (WAVES_INCOMPLETE) or tolerated.
 */
export function planExecutionWaves(graph: Graph): { plan: ExecutionPlan; unresolved: string[] } {
  const nodes = graph.nodes || {};
  const ids = Object.keys(nodes);

  const isMem = graph.topology === "memory-augmented";
  const memCfg = isMem ? graph.topology_config?.memory || {} : {};
  const curatorName = isMem ? memCfg.curator_node || "curator" : null;
  const cadence = memCfg.cadence || "on_node_complete";
  const every = memCfg.every || 1;
  const hasCurator = curatorName !== null && Object.hasOwn(nodes, curatorName);
  const actionIds = hasCurator ? ids.filter((id) => id !== curatorName) : ids;

  const actionNodes = Object.fromEntries(actionIds.map((id) => [id, nodes[id]]));
  const { waves: actionWaves, unresolved } = computeWaves(actionNodes);

  // Interleave curator waves at cadence; always finish with one end-of-run curation.
  type Stage = { kind: "action"; ids: string[] } | { kind: "curator" };
  const stages: Stage[] = [];
  let completedActions = 0;
  let lastCuratedAt = 0;
  actionWaves.forEach((w) => {
    stages.push({ kind: "action", ids: w });
    completedActions += w.length;
    if (hasCurator) {
      const fire =
        cadence === "on_node_complete" ||
        (cadence === "every" && Math.floor(completedActions / every) > Math.floor(lastCuratedAt / every));
      if (fire) {
        stages.push({ kind: "curator" });
        lastCuratedAt = completedActions;
      }
    }
  });
  // End-of-run curation: fire if the last crossing happened at a multiple of
  // `every` but the current cumulative total no longer is — a threshold was
  // passed since the last fire.
  if (
    hasCurator &&
    actionWaves.length > 0 &&
    lastCuratedAt > 0 &&
    lastCuratedAt < completedActions &&
    completedActions % every !== 0 &&
    lastCuratedAt % every === 0
  ) {
    stages.push({ kind: "curator" });
  }

  // HookRef commands ride the payload so /gk:execute can run them without
  // re-reading graph.yaml. on_fanout_dispatch stays declared-but-unused:
  // no consumer exists, and inventing one would be speculative.
  const nodeHooks = graph.hooks?.on_node_complete ?? [];
  const nodeObj = (id: string): PlanNode => ({
    id,
    agent: nodes[id]?.agent,
    model: nodes[id]?.model || "sonnet",
    objective: nodes[id]?.objective?.trim() || "",
    tools: nodes[id]?.tools || [],
    skills: nodes[id]?.skills || [],
    refs: nodes[id]?.refs || [],
    depend_on: nodes[id]?.depend_on || [],
    loop: nodes[id]?.loop || null,
    evidence: nodes[id]?.evidence || [],
    advisor: nodes[id]?.advisor ?? null,
    fan_out: nodes[id]?.fan_out ?? null,
    hooks: nodeHooks,
  });

  // Materialize waves; curator waves carry `curator: true` + the recall skill.
  const waves: PlanWave[] = stages.map((stage, i) => {
    if (stage.kind === "curator") {
      const skills = Array.from(new Set([...(nodes[curatorName!]?.skills || []), "gk-recall"]));
      return { wave: i, parallel: false, curator: true, nodes: [{ ...nodeObj(curatorName!), skills }] };
    }
    return { wave: i, parallel: stage.ids.length > 1, nodes: stage.ids.map(nodeObj) };
  });

  const plan: ExecutionPlan = {
    graph: graph.metadata?.name,
    topology: graph.topology,
    total_waves: waves.length,
    total_nodes: ids.length,
    waves,
    evidence_required: graph.evidence?.required_keys || [],
    on_graph_complete: graph.hooks?.on_graph_complete ?? [],
  };
  if (hasCurator) {
    plan.memory = {
      curator_node: curatorName!,
      cadence,
      every,
      recall_topk: memCfg.recall_topk ?? 5,
      expire_policy: memCfg.expire_policy ?? "act_r",
      null_intervention_allowed: memCfg.null_intervention_allowed ?? true,
    };
  }
  return { plan, unresolved };
}
