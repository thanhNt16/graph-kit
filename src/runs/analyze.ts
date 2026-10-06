import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import { GraphKitError } from "../errors.js";
import { GraphSchema } from "../schemas/graph.schema.js";
import {
  type AdvisorEvent,
  activeRun,
  DISPOSITION_PATTERN,
  hasDisposition,
  listRunIds,
  RUN_ID_PATTERN,
  readAdvisorEvents,
  readRunMeta,
  readTrace,
  type TraceLine,
} from "./ledger.js";
import { readRoundJournals } from "./loops.js";

/**
 * `gk run analyze` — Better-SLP telemetry over one run's ledger. Pure read:
 * trace.jsonl, advisor.jsonl, the round journals, and (when still readable)
 * the run's recorded graph for eval-gate and loop-limit semantics. Every
 * suggestion must be grounded in evidence actually present; a clean ledger
 * yields an empty suggestions array.
 */

export interface AnalyzeResult {
  run_id: string;
  duration_ms: number;
  nodes: { ok: number; fail: number; skipped: number; challenge: number; integration_failures: number };
  escalations: { advisor_fired: number; advisor_then_ok: number };
  /** Challenge adjudication over the run — dispositions parsed from `disposition=*` notes. */
  challenges: { total: number; adjudicated: number; dispositions: Record<string, number> };
  /** Extra trace attempts per node — only nodes executed more than once. */
  retries: Record<string, number>;
  loops: {
    rounds: number;
    no_progress_stops: number;
    exhausted: boolean;
    judged: number;
    gate: TraceLine["status"] | null;
  };
  suggestions: string[];
}

const runsDir = (cwd: string) => join(cwd, ".graphkit", "runs");

function resolveRun(cwd: string, requested?: string): string {
  if (requested) {
    const valid = RUN_ID_PATTERN.test(requested) && existsSync(join(runsDir(cwd), requested));
    if (!valid) throw new GraphKitError("RUN_NOT_FOUND", `no run "${requested}" under ${runsDir(cwd)}`);
    return requested;
  }
  const active = activeRun(cwd);
  if (active) return basename(active);
  const all = listRunIds(cwd);
  if (all.length === 0)
    throw new GraphKitError("NO_RUNS", `no runs under ${runsDir(cwd)} — start one with \`gk run start\``);
  return all[all.length - 1];
}

/** Parsed recorded graph, or null when missing/drifted — loop analysis degrades, the audit never fails. */
function loadGraph(path: string | undefined) {
  if (!path) return null;
  try {
    const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(path, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function analyzeRun(cwd: string, requested?: string): AnalyzeResult {
  const id = resolveRun(cwd, requested);
  const meta = readRunMeta(cwd, id);
  const trace = readTrace(cwd, id);
  const advisors = readAdvisorEvents(cwd, id);

  const counts = { ok: 0, fail: 0, skipped: 0, challenge: 0 };
  let integration_failures = 0;
  const dispositions: Record<string, number> = {};
  let adjudicated = 0;
  const byNode = new Map<string, TraceLine[]>();
  for (const line of trace) {
    counts[line.status]++;
    if (line.status === "challenge") {
      const m = line.notes?.match(DISPOSITION_PATTERN);
      if (m) {
        adjudicated++;
        dispositions[m[1]] = (dispositions[m[1]] ?? 0) + 1;
      }
    } else if (line.status === "fail" && line.notes?.startsWith("merge-conflict:")) {
      integration_failures++;
    }
    const list = byNode.get(line.node) ?? [];
    list.push(line);
    byNode.set(line.node, list);
  }

  const endAt = meta.ended_at ?? trace[trace.length - 1]?.at ?? meta.started_at;
  const duration_ms = Math.max(0, Date.parse(endAt) - Date.parse(meta.started_at));

  // Hit-rate: an advisor firing "worked" when the node reached ok at or after the firing.
  const okAfter = (node: string, since: string) =>
    trace.some((l) => l.node === node && l.status === "ok" && Date.parse(l.at) >= Date.parse(since));
  const advisor_then_ok = advisors.filter((ev) => okAfter(ev.node, ev.at)).length;

  const journals = readRoundJournals(cwd, id);
  const rounds = journals.reduce((n, j) => n + j.lines.length, 0);
  let no_progress_stops = 0;
  for (const j of journals)
    for (let i = 1; i < j.lines.length; i++)
      if (j.lines[i].fingerprint === j.lines[i - 1].fingerprint) no_progress_stops++;

  const graph = loadGraph(meta.graph_path);
  const gateNodes = graph
    ? new Set(
        Object.entries(graph.nodes)
          .filter(([, n]) => n.role === "eval-gate")
          .map(([nodeId]) => nodeId),
      )
    : null;
  let exhausted = false;
  if (graph) {
    for (const j of journals) {
      const cfg = graph.loops?.[j.group];
      if (!cfg || j.lines.length === 0) continue;
      const limit = cfg.no_progress_limit ?? null;
      if (limit != null) {
        let streak = 1;
        for (let i = j.lines.length - 1; i > 0 && j.lines[i].fingerprint === j.lines[i - 1].fingerprint; i--) streak++;
        if (streak >= limit) exhausted = true;
      }
      if (j.lines.length >= cfg.max_rounds) exhausted = true;
    }
  }
  const judgedLines = gateNodes ? trace.filter((l) => gateNodes.has(l.node)) : [];

  const suggestions: string[] = [];

  // (a) advisor fired but no subsequent ok — the escalation did not unblock the node
  const advised = new Map<string, AdvisorEvent[]>();
  for (const ev of advisors) {
    const list = advised.get(ev.node) ?? [];
    list.push(ev);
    advised.set(ev.node, list);
  }
  for (const [node, evs] of advised)
    if (!evs.some((ev) => okAfter(node, ev.at)))
      suggestions.push(`advisor escalation for ${node} did not unblock; consider raising effort or timeout_ms`);

  // (b) 3+ failures at similar durations — a systematic premise problem, not transient noise
  for (const [node, ls] of byNode) {
    const fails = ls.filter((l) => l.status === "fail" && l.duration_ms != null).map((l) => l.duration_ms as number);
    if (fails.length < 3) continue;
    const median = [...fails].sort((a, b) => a - b)[Math.floor(fails.length / 2)];
    if (fails.every((d) => Math.abs(d - median) <= 0.25 * median))
      suggestions.push(`repeated ${node} failures at ~${median / 1000}s suggest a premise problem, not transient`);
  }

  // (c) a challenge is the node's last word with no disposition= stamp — never adjudicated
  for (const [node, ls] of byNode) {
    const last = ls[ls.length - 1];
    if (last.status === "challenge" && !hasDisposition(last.notes))
      suggestions.push(`challenge raised on ${node} but never adjudicated`);
  }

  // (d) large run, zero dissent — prompt (not alarm) that premises are challengeable
  if (advisors.length === 0 && counts.challenge === 0 && trace.length > 10)
    suggestions.push(
      `no dissent observed across ${trace.length} node executions — are peers aware their premises are challengeable? (gk run node <id> --status challenge records dissent)`,
    );

  const retries = Object.fromEntries(
    [...byNode]
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, ls]) => ls.length > 1)
      .map(([node, ls]) => [node, ls.length - 1]),
  );

  return {
    run_id: id,
    duration_ms,
    nodes: { ...counts, integration_failures },
    challenges: { total: counts.challenge, adjudicated, dispositions },
    escalations: { advisor_fired: advisors.length, advisor_then_ok },
    retries,
    loops: {
      rounds,
      no_progress_stops,
      exhausted,
      judged: judgedLines.length,
      gate: judgedLines.at(-1)?.status ?? null,
    },
    suggestions,
  };
}
