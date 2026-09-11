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
