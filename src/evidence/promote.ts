import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { gateGraph } from "../cli/commands/gate.js";
import { GraphKitError } from "../errors.js";
import { isNodeLine, listRunIds, RUN_ID_PATTERN, readRunIndex, readRunMeta, readTrace } from "../runs/ledger.js";
import { type Graph, GraphSchema } from "../schemas/graph.schema.js";
import { loadCriteria } from "./criteria.js";

/**
 * Failure-to-scenario promotion (`gk evidence promote`) — turn a blocked run
 * into a permanent regression artifact. Reads the run's ledger and replays
 * the deterministic evidence gate over the recorded graph: the failed
 * criteria, per-node statuses, and evidence digests observed at promotion
 * time are frozen into a loadable `case.yaml` scenario (and, with --holdout,
 * a sealed `criteria/<slug>.holdout.md` rubric eval-gate nodes can grade
 * against). A run with nothing blocking it is an error, not a no-op.
 */

export interface PromoteOptions {
  run?: string;
  node?: string;
  /** Directory for the scenario fixture, relative to cwd (default: scenarios/promoted). */
  out?: string;
  holdout?: boolean;
}

export interface PromoteResult {
  run_id: string;
  node: string;
  scenario_dir: string;
  case_file: string;
  holdout_file: string | null;
  failed_criteria: string[];
  git_hint: string;
}

const runsDir = (cwd: string) => join(cwd, ".graphkit", "runs");

function resolveRun(cwd: string, requested?: string): string {
  if (requested) {
    const valid = RUN_ID_PATTERN.test(requested) && existsSync(join(runsDir(cwd), requested));
    if (!valid) throw new GraphKitError("RUN_NOT_FOUND", `no run "${requested}" under ${runsDir(cwd)}`);
    return requested;
  }
  const all = listRunIds(cwd);
  if (all.length === 0)
    throw new GraphKitError("NO_RUNS", `no runs under ${runsDir(cwd)} — start one with \`gk run start\``);
  return all[all.length - 1];
}

/** The run's recorded graph, or null when the file is gone or no longer parses. */
function loadRecordedGraph(meta: { graph_path?: string }): Graph | null {
  if (!meta.graph_path || !existsSync(meta.graph_path)) return null;
  try {
    const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(meta.graph_path, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function promoteFailure(cwd: string, opts: PromoteOptions): PromoteResult {
  const id = resolveRun(cwd, opts.run);
  const meta = readRunMeta(cwd, id);
  const trace = readTrace(cwd, id);
  const indexEntry = readRunIndex(cwd).find((e) => e.id === id);
  const graph = loadRecordedGraph(meta);

  // Replay the deterministic gate over the recorded graph's evidence contract.
  // The gate is pure-read, so the verdict reflects the criteria as they stand —
  // the same read `gk gate` made when the run was blocked.
  const gate = graph
    ? gateGraph(graph.evidence.required_keys, join(cwd, graph.outputs.evidence_dir), {
        cwd,
        strict: graph.evidence.freshness === "strict",
        requireLanded: graph.evidence.require_landed === true,
        features: graph.features,
      })
    : null;

  const blocked = gate?.verdict === "BLOCK" || indexEntry?.status === "blocked" || indexEntry?.status === "failed";
  if (!blocked) {
    throw new GraphKitError(
      "NOTHING_TO_PROMOTE",
      `run "${id}" has no blocking verdict to promote — promote is for failed runs, not passed ones`,
      { run_id: id, verdict: gate?.verdict ?? null, status: indexEntry?.status ?? null },
    );
  }

  // Failed criteria: keys the gate scored non-ok, plus ok-but-unfresh keys
  // (stale/foreign) that contributed to a strict block.
  const failed = new Set<string>(gate?.missing ?? []);
  if (gate)
    for (const [k, f] of Object.entries(gate.freshness))
      if ((f === "stale" || f === "foreign") && gate.scorecard[k] === "ok") failed.add(k);

  // Node statuses: latest node-round per node (landed events carry no verdict).
  const nodeStatuses = new Map<string, string>();
  for (const t of trace) if (isNodeLine(t)) nodeStatuses.set(t.node, t.status);

  const node =
    opts.node ??
    (() => {
      const nodeLines = trace.filter(isNodeLine);
      // Prefer the eval-gate node whose latest round failed — that is the
      // verdict that held the merge; else the most recent failed/challenged
      // node; else the last node that ran.
      const gateIds = graph
        ? new Set(
            Object.entries(graph.nodes)
              .filter(([, n]) => n.role === "eval-gate")
              .map(([k]) => k),
          )
        : new Set<string>();
      for (let i = nodeLines.length - 1; i >= 0; i--)
        if (gateIds.has(nodeLines[i].node) && nodeStatuses.get(nodeLines[i].node) === "fail") return nodeLines[i].node;
      for (let i = nodeLines.length - 1; i >= 0; i--)
        if (nodeLines[i].status === "fail" || nodeLines[i].status === "challenge") return nodeLines[i].node;
      return nodeLines.at(-1)?.node ?? Object.keys(graph?.nodes ?? {})[0] ?? "run";
    })();

  if (failed.size === 0) {
    // Blocked without a scored criterion (e.g. unlanded work, feature gate):
    // the scenario still pins the failed node's declared evidence keys.
    const declared = graph?.nodes[node]?.evidence ?? [];
    for (const k of declared) failed.add(k);
    if (failed.size === 0) for (const k of graph?.evidence.required_keys ?? []) failed.add(k);
  }

  const observed: Record<string, string | null> = {};
  for (const k of graph?.evidence.required_keys ?? []) observed[k] = gate?.manifest[k]?.sha256 ?? null;

  const objective = graph?.nodes[node]?.objective ?? null;

  const caseDoc: Record<string, unknown> = {
    id: `${id}-${node}`,
    category: "regression",
    mode: "work_product",
    rubric: "strict",
    input: {
      required_keys: graph?.evidence.required_keys ?? [...failed],
      ...(objective ? { objective } : {}),
    },
    evidence: observed,
    expected_verdict: "BLOCK",
    promoted_from: {
      run_id: id,
      graph: meta.graph,
      graph_sha256: meta.graph_sha256,
      node,
      at: indexEntry?.ended_at ?? meta.started_at,
      status: indexEntry?.status ?? "blocked",
    },
    failed_criteria: [...failed].sort(),
    node_statuses: Object.fromEntries([...nodeStatuses].sort(([a], [b]) => a.localeCompare(b))),
  };

  const baseDir = opts.out ?? join("scenarios", "promoted");
  const scenarioDir = join(cwd, baseDir, `${id}-${slugify(node)}`);
  mkdirSync(scenarioDir, { recursive: true });
  const caseFile = join(scenarioDir, "case.yaml");
  writeFileSync(caseFile, YAML.stringify(caseDoc));

  let holdoutFile: string | null = null;
  if (opts.holdout) {
    const slug = slugify(`${node}-regression`);
    const descriptions = loadCriteria(cwd, [...failed]);
    const lines = [...failed]
      .sort()
      .map((k) => `- \`${k}\`${descriptions.get(k)?.description ? ` — ${descriptions.get(k)!.description}` : ""}`);
    const digests = Object.entries(observed)
      .map(([k, sha]) => `- \`${k}\`: ${sha ?? "(absent)"}`)
      .join("\n");
    const body = [
      `Regression criterion promoted from run \`${id}\`.`,
      "",
      "This criterion REGRESSES if any of the following is absent or stale again:",
      "",
      ...lines,
      "",
      "Original failure:",
      `- run: \`${id}\` (status: ${indexEntry?.status ?? "blocked"}, ${indexEntry?.ended_at ?? meta.started_at})`,
      `- node: \`${node}\``,
      "- evidence digests at failure:",
      digests,
    ].join("\n");
    const criteriaDir = join(cwd, "criteria");
    mkdirSync(criteriaDir, { recursive: true });
    holdoutFile = join(criteriaDir, `${slug}.holdout.md`);
    writeFileSync(holdoutFile, `---\nid: ${slug}\nkind: report\n---\n\n${body}\n`);
  }

  const rel = (p: string) => p.slice(cwd.length + 1);
  const paths = [rel(caseFile), ...(holdoutFile ? [rel(holdoutFile)] : [])];
  return {
    run_id: id,
    node,
    scenario_dir: rel(scenarioDir),
    case_file: rel(caseFile),
    holdout_file: holdoutFile ? rel(holdoutFile) : null,
    failed_criteria: [...failed].sort(),
    git_hint: `git add ${paths.join(" ")}`,
  };
}
