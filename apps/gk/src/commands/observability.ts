import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GraphKitError } from "../errors.js";
import type { RunProvenance } from "../runtime/store.js";
import { readRun } from "../runtime/store.js";
import type { Event, Lease, Run, Verdict } from "../schemas.js";
import type { LoadedTemplate } from "../templates/loader.js";

export interface TraceLine {
  seq: number;
  event: Event;
}

export interface EvidenceBranches {
  pending: string[];
  completed: string[];
  failed: string[];
}

export interface EvidenceEntry {
  kind: "dispatch" | "submit" | "command" | "human" | "reject" | "error";
  node?: string;
  timestamp: string;
  lease?: string;
  exit_code?: number;
  verdict?: Verdict;
  actor?: string;
  work_item?: string;
  details?: unknown;
}

export interface CommandEvidence {
  node: string;
  argv: string[];
  exit_code: number;
}

export interface ArtifactEvidence {
  node: string;
  save_as: string;
  value: unknown;
}

export interface HumanAction {
  node: string;
  actor: string;
  timestamp: string;
  details?: unknown;
}

export interface EvidenceReport {
  run_id: string;
  template: string;
  version: string;
  harness: string;
  status: string;
  current_node: string | null;
  iteration: number;
  verdict: Verdict | null;
  branches: EvidenceBranches;
  elapsed_ms: number;
  commands: CommandEvidence[];
  human_actions: HumanAction[];
  artifacts: ArtifactEvidence[];
  entries: EvidenceEntry[];
  events: number;
}

/** Immutable evidence: the append-only event log, folded without hiding failed attempts. */
export async function evidenceReport(
  project: string,
  runId: string,
  loaded: LoadedTemplate | undefined,
  now = Date.now(),
): Promise<EvidenceReport> {
  const docs = await readRun(project, runId);
  const events = await readEventLog(project, runId);
  const entries = events.map((event) => foldEvent(event));
  const elapsed_ms = Math.max(0, now - (await runStarted(project, runId, events)));
  return {
    run_id: docs.run.run_id,
    template: loaded?.manifest.name ?? docs.run.template ?? "",
    version: loaded?.manifest.version ?? "",
    harness: loaded?.manifest.harness ?? docs.run.harness ?? "claude",
    status: docs.run.status,
    current_node: docs.run.current_nodes[0] ?? null,
    iteration: docs.run.iteration,
    verdict: docs.run.verdict,
    branches: branchEvidence(docs.run, docs.leases, events),
    elapsed_ms,
    commands: entries
      .filter((e) => e.kind === "command")
      .map((e) => ({
        node: e.node ?? "",
        argv: (e.details as { argv?: string[] } | undefined)?.argv ?? [],
        exit_code: e.exit_code ?? 0,
      })),
    human_actions: entries
      .filter((e) => e.kind === "submit" && e.details && typeof e.details === "object" && "action" in e.details)
      .map((e) => ({ node: e.node ?? "", actor: e.actor ?? "human", timestamp: e.timestamp, details: e.details })),
    artifacts: artifactEvidence(docs.state),
    entries,
    events: events.length,
  };
}

/** Run start time: the first appended event, else the `0000-start` checkpoint provenance. */
async function runStarted(project: string, runId: string, events: Event[]): Promise<number> {
  for (const event of events) {
    const ts = Date.parse(event.timestamp);
    if (Number.isFinite(ts)) return ts;
  }
  try {
    const checkpoint = JSON.parse(
      await readFile(join(project, ".graphkit", "runs", runId, "checkpoints", "0000-start.json"), "utf8"),
    ) as { provenance?: RunProvenance };
    const ts = Date.parse(checkpoint.provenance?.timestamp ?? "");
    if (Number.isFinite(ts)) return ts;
  } catch {
    // no checkpoint yet; fall back to first event value of 0
  }
  return 0;
}

export async function readEventLog(project: string, runId: string): Promise<Event[]> {
  const path = join(project, ".graphkit", "runs", runId, "events.jsonl");
  const raw = await readFile(path, "utf8");
  if (!raw.trim()) return [];
  const events: Event[] = [];
  for (const line of raw.trim().split("\n")) {
    const event = JSON.parse(line) as Event;
    if (event && typeof event === "object" && "type" in event) events.push(event);
    else throw new GraphKitError("SCHEMA_VIOLATION", `corrupt event line in '${runId}' events.jsonl`);
  }
  return events;
}

export async function traceRun(project: string, runId: string): Promise<TraceLine[]> {
  const events = await readEventLog(project, runId);
  return events.map((event, seq) => ({ seq, event }));
}

function foldEvent(event: Event): EvidenceEntry {
  const base: EvidenceEntry = { kind: "error", timestamp: event.timestamp };
  switch (event.type) {
    case "dispatch":
    case "human":
    case "submit":
    case "command":
    case "reject":
    case "error":
      base.kind = event.type;
      break;
  }
  if (event.node !== undefined) base.node = event.node;
  if (event.lease !== undefined) base.lease = event.lease;
  if (event.actor !== undefined) base.actor = event.actor;
  if (event.details !== undefined) base.details = event.details;
  if (event.type === "submit" && event.details && typeof event.details === "object") {
    const details = event.details as Record<string, unknown>;
    if (typeof details.verdict === "string") base.verdict = details.verdict as Verdict;
    if (typeof details.work_item === "string") base.work_item = details.work_item;
  }
  if (event.type === "command" && event.details && typeof event.details === "object") {
    const details = event.details as Record<string, unknown>;
    if (typeof details.exit_code === "number") base.exit_code = details.exit_code;
  }
  return base;
}

/** Two flanks of every branch: where it sits now and where it failed along the way. */
function branchEvidence(run: Run, leases: Lease[], events: Event[]): EvidenceBranches {
  const failedNodes = new Set<string>();
  for (const event of events) {
    if (event.type === "reject") failedNodes.add(event.node ?? "");
    if (
      event.type === "submit" &&
      event.details &&
      typeof event.details === "object" &&
      (event.details as Record<string, unknown>).verdict === "failed"
    ) {
      failedNodes.add(event.node ?? "");
    }
  }
  for (const lease of leases) if (lease.status === "expired") failedNodes.add(lease.node);
  const pending = new Set(run.current_nodes);
  return {
    pending: [...pending],
    completed: run.completed_deterministic_nodes ?? [],
    failed: [...failedNodes].filter(Boolean),
  };
}

/** Deterministic output surface: artifacts reachable from declared save_as keys. */
function artifactEvidence(state: Record<string, unknown>): ArtifactEvidence[] {
  return Object.keys(state).map((key) => {
    const value = state[key];
    const node =
      value !== null && typeof value === "object" && "node" in value ? String((value as { node: unknown }).node) : "";
    return { node, save_as: key, value };
  });
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
}

export interface MermaidGraph {
  nodes: { id: string; class: string; label: string }[];
  edges: MermaidEdge[];
  status: string;
  verdict: Verdict | null;
  current: string | null;
}

function conditionLabel(edge: { when?: string; on_error?: string | string[]; verdict?: Verdict }): string | undefined {
  if (edge.verdict) return edge.verdict;
  if (edge.when) return edge.when;
  return undefined;
}

export async function mermaidGraph(loaded: LoadedTemplate, project: string, runId: string): Promise<MermaidGraph> {
  const { workflow } = loaded;
  const nodes = Object.values(workflow.nodes).map((node) => ({ id: node.id, class: node.type, label: node.type }));
  const edges: MermaidEdge[] = [];
  for (const edge of workflow.edges) {
    const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
    for (const target of targets) edges.push({ from: edge.from, to: target, label: conditionLabel(edge) });
  }
  let status = "unknown";
  let verdict: Verdict | null = null;
  let current: string | null = null;
  try {
    const run = (await readRun(project, runId)).run;
    status = run.status;
    verdict = run.verdict;
    current = run.current_nodes[0] ?? null;
  } catch {
    // static topology when run does not exist
  }
  return { nodes, edges, status, verdict, current };
}

export function renderMermaid(graph: MermaidGraph): string {
  const rendered: string[] = ["flowchart TD"];
  for (const node of graph.nodes) rendered.push(`    ${node.id}[${node.id} ${node.label}]`);
  for (const edge of graph.edges) {
    const label = edge.label ? ` -- "${edge.label}"` : "";
    rendered.push(`    ${edge.from} --> ${edge.to}${label}`);
  }
  const stateLine = graph.verdict ? `    status[${graph.status}/${graph.verdict}]` : `    status[${graph.status}]`;
  rendered.push(stateLine);
  if (graph.current) rendered.push(`    status --> ${graph.current}`);
  return `${rendered.join("\n")}\n`;
}
