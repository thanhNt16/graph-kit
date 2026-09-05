import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Graph } from "../compiler/validate.js";
import { GraphSchema, type LoopGroup } from "../schemas/graph.schema.js";
import { saveSessionGraph, setActiveGraphId } from "../store/index.js";
import { activeRun, readRunMeta, readTrace, startRun, type TraceLine } from "./ledger.js";

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
  const active = activeRun(cwd);
  if (active) throw new Error(`RUN_ACTIVE: run already active at ${active}; run \`gk run end\` first`);
  if (rec.pending.length === 0)
    return { resumed: false, reason: "NOTHING_TO_RESUME", pending: [], satisfied: rec.satisfied, skipped: rec.skipped };
  if (opts.dryRun)
    return { resumed: false, reason: "DRY_RUN", pending: rec.pending, satisfied: rec.satisfied, skipped: rec.skipped };
  const derived = deriveResumeGraph(rec, runId);
  validateDerivedGraph(derived);
  const session = saveSessionGraph(derived, derived.metadata.name, cwd);
  setActiveGraphId(session.id, cwd);
  const run = startRun(cwd, session.path, new Date().toISOString(), runId);
  return { resumed: true, session, run, pending: rec.pending, satisfied: rec.satisfied, skipped: rec.skipped };
}

export interface Reconciliation {
  cwd: string;
  runId: string;
  graphPath: string;
  graph: Graph;
  evidenceDir: string;
  satisfied: string[];
  pending: string[];
  skipped: Array<{ node: string; reason: string }>;
}
function parseGraph(path: string): Graph {
  const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(path, "utf-8")));
  if (!parsed.success)
    throw new Error(
      `RESUME_GRAPH_INVALID: recorded graph ${path} no longer parses: ${parsed.error.issues[0]?.message}`,
    );
  return parsed.data;
}
function evidenceOnDisk(cwd: string, evidenceDir: string, keys: string[]): boolean {
  return keys.every((k) => {
    const p = join(cwd, evidenceDir, `${k}.md`);
    return existsSync(p) && readFileSync(p, "utf-8").trim().length > 0;
  });
}
export function reconcileRun(
  cwd: string,
  runId: string,
  opts: { fromNode?: string; force?: boolean } = {},
): Reconciliation {
  const meta = readRunMeta(cwd, runId);
  if (typeof meta.graph_path !== "string" || typeof meta.graph_sha256 !== "string")
    throw new Error(
      `RESUME_RUN_NOT_FOUND: run ${runId} predates graph tracking (no graph_path/graph_sha256 in meta.json)`,
    );
  if (!opts.force) {
    if (!existsSync(meta.graph_path))
      throw new Error(
        `RESUME_GRAPH_DRIFT: recorded graph ${meta.graph_path} no longer exists (re-run gk init/graph, or --force)`,
      );
    const sha = createHash("sha256").update(readFileSync(meta.graph_path, "utf-8")).digest("hex");
    if (sha !== meta.graph_sha256)
      throw new Error(
        `RESUME_GRAPH_DRIFT: ${meta.graph_path} changed since run ${runId} started (expected sha ${meta.graph_sha256.slice(0, 12)}…) — use --force to override`,
      );
  }
  const graph = parseGraph(meta.graph_path);
  const names = Object.keys(graph.nodes);
  if (opts.fromNode != null && !names.includes(opts.fromNode))
    throw new Error(`RESUME_BAD_FROM_NODE: --from-node "${opts.fromNode}" is not a node of ${meta.graph_path}`);
  const last = new Map<string, TraceLine>();
  for (const line of readTrace(cwd, runId)) last.set(line.node, line);
  const evidenceDir = graph.outputs?.evidence_dir ?? ".graphkit/evidence/";
  const satisfied = new Set<string>();
  for (const name of names) {
    const line = last.get(name);
    if (line?.status === "ok" && evidenceOnDisk(cwd, evidenceDir, line.evidence)) satisfied.add(name);
  }
  const pending = opts.fromNode != null ? [opts.fromNode] : names.filter((n) => !satisfied.has(n));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, node] of Object.entries(graph.nodes))
      if (!pending.includes(name) && node.depend_on.some((d) => pending.includes(d))) {
        pending.push(name);
        grew = true;
      }
  }
  const skipped = names
    .filter((n) => satisfied.has(n) && !pending.includes(n))
    .map((node) => ({ node, reason: "passed with evidence on disk" }));
  return {
    cwd,
    runId,
    graphPath: meta.graph_path,
    graph,
    evidenceDir,
    satisfied: [...satisfied].filter((n) => !pending.includes(n)).sort(),
    pending: pending.sort(),
    skipped,
  };
}

/**
 * Gate applied to a derived resume graph before anything is written: schema
 * parse plus every structural compiler rule that a pending-only derived graph
 * can still violate (loop_node_exists, loop_gate_evidence_declared,
 * evidence-keys coverage, eval-gate-depend_on, memory-curator-node). Throws
 * RESUME_DERIVED_INVALID with the issue list. Deliberately not full
 * validateGraph: its disk-state rules (agent binding, refs-exist) check
 * machine state, not graph shape, and hold for derived graphs by construction.
 */
export function validateDerivedGraph(derived: Graph): void {
  const parsed = GraphSchema.safeParse(derived);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`RESUME_DERIVED_INVALID: derived graph failed schema: ${issues}`);
  }
  for (const [i, group] of (derived.loops ?? []).entries()) {
    const produced = new Set<string>();
    for (const node of group.nodes) {
      if (!derived.nodes[node])
        throw new Error(
          `RESUME_DERIVED_INVALID: derived graph failed loop validation: loops[${i}] — loop node "${node}" does not exist in graph.nodes`,
        );
      for (const key of derived.nodes[node]!.evidence) produced.add(key);
    }
    for (const key of group.gate_evidence ?? []) {
      if (!produced.has(key))
        throw new Error(
          `RESUME_DERIVED_INVALID: derived graph failed loop validation: loops[${i}].gate_evidence — gate_evidence key "${key}" is not declared by any node in the loop group`,
        );
    }
  }
  // Compiler rule 5 (validate.ts): every required evidence key must be produced
  // by a node the derived graph still declares.
  const declared = new Set(Object.values(derived.nodes).flatMap((n) => n.evidence));
  for (const key of derived.evidence.required_keys) {
    if (!declared.has(key)) {
      throw new Error(
        `RESUME_DERIVED_INVALID: derived graph failed validation: evidence-keys — Required evidence key "${key}" is not produced by any node`,
      );
    }
  }
  // Compiler rule 6: memory-augmented graphs must keep their curator node.
  if (derived.topology === "memory-augmented") {
    const tc = derived.topology_config as Record<string, any>;
    const curatorNode = tc?.memory?.curator_node ?? "curator";
    if (!derived.nodes[curatorNode]) {
      throw new Error(
        `RESUME_DERIVED_INVALID: derived graph failed validation: memory-curator-node — memory-augmented memory.curator_node "${curatorNode}" is not defined in nodes`,
      );
    }
  }
  // Compiler rule 7: eval-gate nodes must keep at least one producer dep.
  for (const [id, node] of Object.entries(derived.nodes)) {
    if (node.role === "eval-gate" && node.depend_on.length === 0) {
      throw new Error(
        `RESUME_DERIVED_INVALID: derived graph failed validation: eval-gate-depend_on — nodes.${id}.depend_on — eval-gate node must depend_on at least one producer node`,
      );
    }
  }
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
    // fan_out.briefs_from naming a dropped (satisfied) node would dangle — its
    // evidence was already replayed as refs above, so drop the fan_out config.
    const { fan_out: fanOut, ...nodeRest } = node;
    nodes[name] = {
      ...nodeRest,
      depend_on: carriedDeps,
      ...(fanOut && pending.has(fanOut.briefs_from) ? { fan_out: fanOut } : {}),
      refs: [...node.refs, ...upstreamRefs],
    };
  }

  // Loop groups whose members split across the pending/satisfied boundary must
  // not reference dropped nodes (validateGraph: loop_node_exists /
  // loop_gate_evidence_declared). Prune gate_evidence keys no longer declared
  // by kept members; a group that loses both exit conditions is dropped.
  const loops = rec.graph.loops?.flatMap((group: LoopGroup): LoopGroup[] => {
    const kept = group.nodes.filter((n) => pending.has(n));
    if (kept.length === 0) return [];
    const declared = new Set(kept.flatMap((n) => nodes[n]?.evidence ?? []));
    const gate = group.gate_evidence?.filter((k) => declared.has(k));
    if (!group.stop_when && (!gate || gate.length === 0)) return [];
    const next: LoopGroup = { ...group, nodes: kept };
    if (gate && gate.length > 0) next.gate_evidence = gate;
    else delete next.gate_evidence;
    return [next];
  });

  // Evidence keys produced by satisfied nodes exist on disk (satisfied rule) —
  // they are replayed as refs, so required_keys must shrink to keys the
  // pending nodes still produce or compile's evidence-coverage check fails.
  const declared = new Set(Object.values(nodes).flatMap((n) => n.evidence));
  const derived: Graph = {
    ...rec.graph,
    metadata: { ...rec.graph.metadata, name: `${rec.graph.metadata.name}-resume` },
    nodes,
    evidence: { ...rec.graph.evidence, required_keys: rec.graph.evidence.required_keys.filter((k) => declared.has(k)) },
  };
  if (loops && loops.length > 0) derived.loops = loops;
  else delete derived.loops;
  return derived;
}
