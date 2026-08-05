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
  executable: string;
  exit_code: number;
}

export interface ArtifactEvidence {
  node: string;
  save_as: string;
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

const RECEIPT_LIMIT = 128;

/** Allowlisted receipt details per event type; unknown/legacy keys are dropped. */
export function sanitizeDetails(event: Event): Record<string, unknown> | undefined {
  if (event.details === undefined) return undefined;
  if (event.details === null || typeof event.details !== "object" || Array.isArray(event.details)) return undefined;
  const raw = event.details as Record<string, unknown>;
  const allowed: Record<string, unknown> = {};
  const bounded = (value: unknown): string | undefined =>
    typeof value === "string" ? value.slice(0, RECEIPT_LIMIT) : undefined;
  switch (event.type) {
    case "submit": {
      const verdict = raw.verdict;
      if (typeof verdict === "string") allowed.verdict = verdict.slice(0, RECEIPT_LIMIT);
      const action = bounded(raw.action);
      if (action !== undefined) allowed.action = action;
      const work_item = bounded(raw.work_item);
      if (work_item !== undefined) allowed.work_item = work_item;
      if (Array.isArray(raw.artifact_keys))
        allowed.artifact_keys = raw.artifact_keys
          .slice(0, 8)
          .map(bounded)
          .filter((v): v is string => v !== undefined);
      break;
    }
    case "reject": {
      const code = bounded(raw.code);
      if (code !== undefined) allowed.code = code;
      const work_item = bounded(raw.work_item);
      if (work_item !== undefined) allowed.work_item = work_item;
      break;
    }
    case "command": {
      const executable = bounded(raw.executable);
      if (executable !== undefined) allowed.executable = executable;
      const node = bounded(raw.node);
      if (node !== undefined) allowed.node = node;
      const exit_code = raw.exit_code;
      if (typeof exit_code === "number" && Number.isInteger(exit_code)) allowed.exit_code = exit_code;
      break;
    }
    case "dispatch": {
      if (Array.isArray(raw.items))
        allowed.items = raw.items
          .slice(0, 64)
          .map(bounded)
          .filter((v): v is string => v !== undefined);
      break;
    }
    default:
      return undefined;
  }
  return Object.keys(allowed).length ? allowed : undefined;
}

/** Sanitized event: keep envelope + receipt details only, drop raw/legacy payload keys. */
export function sanitizeEvent(event: Event): Event {
  const clean: Record<string, unknown> = { ...event };
  delete clean.details;
  const sanitized = sanitizeDetails(event);
  if (sanitized) clean.details = sanitized;
  return clean as unknown as Event;
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
        executable:
          e.details &&
          typeof e.details === "object" &&
          typeof (e.details as Record<string, unknown>).executable === "string"
            ? ((e.details as Record<string, unknown>).executable as string)
            : "",
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
  return events.map((event, seq) => ({ seq, event: sanitizeEvent(event) }));
}

function foldEvent(event: Event): EvidenceEntry {
  const clean = sanitizeEvent(event);
  const base: EvidenceEntry = { kind: "error", timestamp: clean.timestamp };
  switch (clean.type) {
    case "dispatch":
    case "human":
    case "submit":
    case "command":
    case "reject":
    case "error":
      base.kind = clean.type;
      break;
  }
  if (clean.node !== undefined) base.node = clean.node;
  if (clean.lease !== undefined) base.lease = clean.lease;
  if (clean.actor !== undefined) base.actor = clean.actor;
  const details = clean.details;
  if (details !== undefined) base.details = details;
  if (clean.type === "submit" && details && typeof details === "object") {
    const record = details as Record<string, unknown>;
    if (typeof record.verdict === "string") base.verdict = record.verdict as Verdict;
    if (typeof record.work_item === "string") base.work_item = record.work_item;
  }
  if (clean.type === "command" && details && typeof details === "object") {
    const record = details as Record<string, unknown>;
    if (typeof record.exit_code === "number") base.exit_code = record.exit_code;
  }
  return base;
}

/** Stable item identity for branch evidence: `work_item ?? lease ?? node`. */
function branchItem(event: Event, fallbackNode: string): string {
  const details = sanitizeDetails(event);
  if (details && typeof details.work_item === "string" && details.work_item) return details.work_item;
  if (event.lease) return event.lease;
  return event.node ?? fallbackNode;
}

/** Two flanks of every branch: where it sits now and where it failed along the way. */
function branchEvidence(run: Run, leases: Lease[], events: Event[]): EvidenceBranches {
  const failed = new Set<string>();
  const now = Date.now();
  for (const event of events) {
    const details = sanitizeDetails(event);
    if (event.type === "reject") failed.add(branchItem(event, event.node ?? ""));
    if (event.type === "submit" && details?.verdict === "failed") failed.add(branchItem(event, event.node ?? ""));
    if (event.type === "command" && details && details.exit_code !== 0) {
      failed.add(typeof details.node === "string" ? details.node : (event.node ?? ""));
    }
  }
  for (const lease of leases) {
    const stale = lease.status === "expired" || (lease.status === "active" && Date.parse(lease.expires_at) <= now);
    if (stale) failed.add(lease.work_item ?? lease.id);
  }
  const pending = new Set(run.current_nodes);
  return {
    pending: [...pending],
    completed: run.completed_deterministic_nodes ?? [],
    failed: [...failed].filter(Boolean),
  };
}

/** Deterministic output surface: artifact identities, never payload values. */
function artifactEvidence(state: Record<string, unknown>): ArtifactEvidence[] {
  return Object.keys(state).map((key) => ({ node: "", save_as: key }));
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

function quote(value: string): string {
  const escaped = Array.from(value)
    .map((char) => {
      const code = char.charCodeAt(0);
      if (char === "\\") return "\\\\";
      if (char === '"') return '\\"';
      if (char === "\n") return "\\n";
      if (char === "\r") return "\\r";
      if (code < 0x20 || code === 0x7f) return `\\u${code.toString(16).padStart(4, "0")}`;
      return char;
    })
    .join("");
  return `"${escaped}"`;
}

export async function mermaidGraph(loaded: LoadedTemplate, project: string, runId: string): Promise<MermaidGraph> {
  const { workflow } = loaded;
  const ids = Object.keys(workflow.nodes).sort();
  const idMap = new Map(ids.map((id, index) => [id, `n${index}`]));
  const idOf = (id: string) => idMap.get(id) ?? `n${idMap.size}`;
  const nodes = ids.map((nodeId) => ({ id: idOf(nodeId), class: workflow.nodes[nodeId].type, label: nodeId }));
  const edges: MermaidEdge[] = [];
  for (const edge of workflow.edges) {
    const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
    for (const target of targets) edges.push({ from: idOf(edge.from), to: idOf(target), label: conditionLabel(edge) });
  }
  let status = "unknown";
  let verdict: Verdict | null = null;
  let current: string | null = null;
  try {
    const run = (await readRun(project, runId)).run;
    status = run.status;
    verdict = run.verdict;
    current = run.current_nodes[0] ? idOf(run.current_nodes[0]) : null;
  } catch {
    // static topology when run does not exist
  }
  return { nodes, edges, status, verdict, current };
}

export function renderMermaid(graph: MermaidGraph): string {
  const rendered: string[] = ["flowchart TD"];
  for (const node of graph.nodes) rendered.push(`    ${node.id}[${quote(`${node.label} ${node.class}`)}]`);
  for (const edge of graph.edges) {
    const label = edge.label ? ` -- ${quote(`label: ${edge.label}`)}` : "";
    rendered.push(`    ${edge.from} --> ${edge.to}${label}`);
  }
  const stateLine = graph.verdict
    ? `    status[${quote(`status: ${graph.status}/${graph.verdict}`)}]`
    : `    status[${quote(`status: ${graph.status}`)}]`;
  rendered.push(stateLine);
  if (graph.current) rendered.push(`    status --> ${graph.current}`);
  return `${rendered.join("\n")}\n`;
}
