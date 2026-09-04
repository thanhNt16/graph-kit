import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { readRunMeta, readTrace, type TraceLine } from "./ledger.js";
import { GraphSchema } from "../schemas/graph.schema.js";
import type { Graph } from "../compiler/validate.js";
import { saveSessionGraph, setActiveGraphId } from "../store/index.js";
import { startRun } from "./ledger.js";

export interface ResumeResult {
  resumed: boolean;
  reason?: string;
  session?: { id: string; path: string };
  run?: { id: string; dir: string };
  pending: string[];
  satisfied: string[];
  skipped: Array<{ node: string; reason: string }>;
}

export function resumeRun(
  cwd: string,
  runId: string,
  opts: { fromNode?: string; dryRun?: boolean; force?: boolean } = {},
): ResumeResult {
  const rec = reconcileRun(cwd, runId, opts);
  if (rec.pending.length === 0) return { resumed: false, reason: "NOTHING_TO_RESUME", pending: [], satisfied: rec.satisfied, skipped: rec.skipped };
  if (opts.dryRun) return { resumed: false, reason: "DRY_RUN", pending: rec.pending, satisfied: rec.satisfied, skipped: rec.skipped };
  const derived = deriveResumeGraph(rec, runId);
  const session = saveSessionGraph(derived, derived.metadata.name, cwd);
  setActiveGraphId(session.id, cwd);
  const run = startRun(cwd, session.path, new Date().toISOString(), runId);
  return { resumed: true, session, run, pending: rec.pending, satisfied: rec.satisfied, skipped: rec.skipped };
}

export interface Reconciliation {
  cwd: string; runId: string; graphPath: string; graph: Graph; evidenceDir: string;
  satisfied: string[]; pending: string[]; skipped: Array<{ node: string; reason: string }>;
}
function parseGraph(path: string): Graph {
  const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(path, "utf-8")));
  if (!parsed.success) throw new Error(`RESUME_GRAPH_INVALID: recorded graph ${path} no longer parses: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}
function evidenceOnDisk(cwd: string, evidenceDir: string, keys: string[]): boolean {
  return keys.every((k) => { const p = join(cwd, evidenceDir, `${k}.md`); return existsSync(p) && readFileSync(p, "utf-8").trim().length > 0; });
}
export function reconcileRun(cwd: string, runId: string, opts: { fromNode?: string; force?: boolean } = {}): Reconciliation {
  const meta = readRunMeta(cwd, runId);
  if (typeof meta.graph_path !== "string" || typeof meta.graph_sha256 !== "string") throw new Error(`RESUME_RUN_NOT_FOUND: run ${runId} predates graph tracking (no graph_path/graph_sha256 in meta.json)`);
  if (!opts.force) {
    if (!existsSync(meta.graph_path)) throw new Error(`RESUME_GRAPH_DRIFT: recorded graph ${meta.graph_path} no longer exists (re-run gk init/graph, or --force)`);
    const sha = createHash("sha256").update(readFileSync(meta.graph_path, "utf-8")).digest("hex");
    if (sha !== meta.graph_sha256) throw new Error(`RESUME_GRAPH_DRIFT: ${meta.graph_path} changed since run ${runId} started (expected sha ${meta.graph_sha256.slice(0, 12)}…) — use --force to override`);
  }
  const graph = parseGraph(meta.graph_path); const names = Object.keys(graph.nodes);
  if (opts.fromNode != null && !names.includes(opts.fromNode)) throw new Error(`RESUME_BAD_FROM_NODE: --from-node "${opts.fromNode}" is not a node of ${meta.graph_path}`);
  const last = new Map<string, TraceLine>(); for (const line of readTrace(cwd, runId)) last.set(line.node, line);
  const evidenceDir = graph.outputs?.evidence_dir ?? ".graphkit/evidence/"; const satisfied = new Set<string>();
  for (const name of names) { const line = last.get(name); if (line?.status === "ok" && evidenceOnDisk(cwd, evidenceDir, line.evidence)) satisfied.add(name); }
  let pending = opts.fromNode != null ? [opts.fromNode] : names.filter((n) => !satisfied.has(n));
  for (let grew = true; grew;) { grew = false; for (const [name, node] of Object.entries(graph.nodes)) if (!pending.includes(name) && node.depend_on.some((d) => pending.includes(d))) { pending.push(name); grew = true; } }
  const skipped = names.filter((n) => satisfied.has(n) && !pending.includes(n)).map((node) => ({ node, reason: "passed with evidence on disk" }));
  return { cwd, runId, graphPath: meta.graph_path, graph, evidenceDir, satisfied: [...satisfied].filter((n) => !pending.includes(n)).sort(), pending: pending.sort(), skipped };
}

/** Evidence replay: satisfied upstream deps become refs (paths, ADR-002 layout). */
export function deriveResumeGraph(rec: Reconciliation, parentRunId: string): Graph {
  const pending = new Set(rec.pending);
  const satisfied = new Set(rec.satisfied);
  const trace = readTrace(rec.cwd, rec.runId);
  const lastOk = new Map<string, TraceLine>();
  for (const line of trace) if (line.status === "ok") lastOk.set(line.node, line);

  const nodes: Graph["nodes"] = {};
  for (const [name, node] of Object.entries(rec.graph.nodes)) {
    if (!pending.has(name)) continue;
    const carriedDeps = node.depend_on.filter((d) => pending.has(d));
    const upstreamRefs = node.depend_on
      .filter((d) => satisfied.has(d))
      .flatMap((d) =>
        (lastOk.get(d)?.evidence ?? []).map((k) => ({
          path: join(rec.evidenceDir, `${k}.md`),
          purpose: `resumed evidence from node ${d} (run ${parentRunId})`,
        })),
      );
    nodes[name] = { ...node, depend_on: carriedDeps, refs: [...node.refs, ...upstreamRefs] };
  }

  return {
    ...rec.graph,
    metadata: { ...rec.graph.metadata, name: `${rec.graph.metadata.name}-resume` },
    nodes,
  };
}
