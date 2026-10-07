import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import { GraphKitError } from "../errors.js";
import { activeRunGraph } from "../runs/ledger.js";
import type { Graph } from "../schemas/graph.schema.js";
import { GraphSchema } from "../schemas/graph.schema.js";
import { GraphTemplateSchema, materializeTemplate, type GraphTemplate } from "../schemas/template.schema.js";
import { getActiveGraphId, listSessionGraphs, loadActiveGraph } from "../store/index.js";
import { formatZodIssues } from "./diagnostics.js";
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

// Read + YAML-parse a graph document, wrapping ENOENT in the canonical
// GRAPH_FILE_NOT_FOUND envelope. Shared by loadGraphDoc and (via it) every
// graph-consuming verb, so missing files report identically everywhere.
function readGraphDoc(file: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GraphKitError("GRAPH_FILE_NOT_FOUND", `file not found: ${file}`, {
        file,
        hint: "run `gk graph new <topology>` to scaffold one, or check the path",
      });
    }
    throw e;
  }
  return YAML.parse(raw);
}

/** One YAML document, routed by `kind`: a plain Graph or a GraphTemplate.
 *  THE template-awareness branch — a `kind: GraphTemplate` file never hits
 *  GraphSchema (the 4-issue noise wall, audit F3); it validates against its
 *  own schema instead. */
export type GraphDoc = { kind: "graph"; path: string; graph: Graph } | { kind: "template"; path: string; template: GraphTemplate };

export function loadGraphDoc(file: string): GraphDoc {
  const doc = readGraphDoc(file);
  if (typeof doc === "object" && doc !== null && "kind" in doc && doc.kind === "GraphTemplate") {
    const parsed = GraphTemplateSchema.safeParse(doc);
    if (!parsed.success) {
      throw new GraphKitError("SCHEMA_INVALID", "graph template failed schema validation", {
        issues: formatZodIssues(parsed.error, GraphTemplateSchema),
      });
    }
    return { kind: "template", path: file, template: parsed.data };
  }
  const parsed = GraphSchema.safeParse(doc);
  if (!parsed.success) {
    throw new GraphKitError("SCHEMA_INVALID", "graph.yaml failed schema validation", {
      issues: formatZodIssues(parsed.error, GraphSchema),
    });
  }
  return { kind: "graph", path: file, graph: parsed.data };
}

/** Graph for the preview verb set (waves/ascii/svg/agents/gate). Templates
 *  materialize IN MEMORY with `parameters` defaults — prompt-free, zero disk
 *  writes, no --use. Required parameters without defaults cannot preview
 *  prompt-free → TEMPLATE_NOT_GRAPH with the materialize remedy. */
export function previewGraph(cwd: string, flag?: string): { path: string; graph: Graph } {
  const resolved = resolveGraphPath(cwd, flag);
  const doc = loadGraphDoc(resolved.path);
  if (doc.kind === "graph") return { path: doc.path, graph: doc.graph };
  try {
    return { path: doc.path, graph: materializeTemplate(doc.template, {}) };
  } catch (e) {
    const missing = Object.entries(doc.template.parameters)
      .filter(([, p]) => p.required)
      .map(([name]) => name);
    throw new GraphKitError(
      "TEMPLATE_NOT_GRAPH",
      `TEMPLATE_NOT_GRAPH: template "${doc.template.metadata.name}" needs values it doesn't default (${e instanceof Error ? e.message : String(e)})`,
      {
        name: doc.template.metadata.name,
        missing,
        hint: "materialize first: gk template materialize <name>",
      },
    );
  }
}
