import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { GraphKitError } from "../errors.js";
import { activeRunGraph } from "../runs/ledger.js";
import type { Graph } from "../schemas/graph.schema.js";
import { getActiveGraphId, listSessionGraphs, loadActiveGraph } from "../store/index.js";
import { loadGraph } from "./commands/graph.js";

export interface ResolvedGraph {
  path: string;
  source: "flag" | "run" | "active" | "root";
}

/** THE graph resolver. Explicit flag: file path or session-graph id.
 *  Omitted: active run's recorded graph → session active pointer → ./graph.yaml.
 *  Every command resolves through this — precedence is defined once, here. */
export function resolveGraphPath(cwd: string, flag?: string): ResolvedGraph {
  if (flag) {
    if (existsSync(flag)) return { path: flag, source: "flag" };
    // Uninitialized projects have no session graphs to match — don't let the
    // store's GRAPHKIT_NOT_INITIALIZED mask the honest GRAPH_NOT_FOUND.
    const sessions = existsSync(join(cwd, ".graphkit")) ? listSessionGraphs(cwd) : [];
    const hit = sessions.find((g) => g.id === flag || basename(g.path, ".yaml") === flag);
    if (hit) return { path: hit.path, source: "flag" };
    throw new GraphKitError(
      "GRAPH_NOT_FOUND",
      `GRAPH_NOT_FOUND: ${flag} — not a file and not a session graph id (${sessions.map((g) => g.id).join(", ") || "none"})`,
      { flag, available: sessions.map((g) => g.id) },
    );
  }
  const runGraph = activeRunGraph(cwd);
  if (runGraph && existsSync(runGraph)) return { path: runGraph, source: "run" };
  if (existsSync(join(cwd, ".graphkit")) && getActiveGraphId(cwd) !== null) {
    return { path: loadActiveGraph(cwd).path, source: "active" };
  }
  const root = join(cwd, "graph.yaml");
  if (existsSync(root)) return { path: root, source: "root" };
  // Message leads with the code so message-parsed envelopes keep the honest code.
  throw new GraphKitError(
    "NO_ACTIVE_GRAPH",
    "NO_ACTIVE_GRAPH: no graph resolvable — pass --graph <file|id>, run `gk template materialize --use`, or create ./graph.yaml",
    { cwd },
  );
}

export function resolveGraph(cwd: string, flag?: string): Graph {
  return loadGraph(resolveGraphPath(cwd, flag).path);
}
