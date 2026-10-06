import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { GraphKitError } from "../errors.js";
import { fingerprint } from "../evidence/fingerprint.js";

export interface TraceLine {
  at: string;
  node: string;
  wave: number | null;
  agent: string | null;
  model: string | null;
  status: "ok" | "fail" | "skipped" | "challenge";
  evidence: string[];
  duration_ms: number | null;
  notes: string | null;
  attempt?: number;
}

/** Integration stamp on its own line, appended AFTER the node's ok line.
 *  An event, not an in-place rewrite: rewriting dropped any line another
 *  writer appended between the land's read and its write-back. */
export interface LandEvent {
  at: string;
  node: string;
  status: "landed";
  commit: string;
}

/** Everything trace.jsonl can hold: node rounds plus landed events. */
export type TraceEntry = TraceLine | LandEvent;

export const isNodeLine = (t: TraceEntry): t is TraceLine => t.status !== "landed";

/** Adjudication stamp in a challenge line's notes: `disposition=<value>`.
 *  Any value counts — a typo'd value is still a recorded decision — so the
 *  resume carryover and `gk run analyze` share this one predicate; the
 *  captured value is tallied verbatim (canonical: accept/modify/reject/defer). */
export const DISPOSITION_PATTERN = /\bdisposition=(\w+)/;

export const hasDisposition = (notes: string | null | undefined): boolean =>
  notes != null && DISPOSITION_PATTERN.test(notes);

export interface DispatchLine {
  at: string;
  node: string;
  attempt: number | null;
  via: string;
  pid: number | null;
}

export interface RunIndexLine {
  id: string;
  graph: string;
  graph_sha256: string;
  started_at: string;
  ended_at: string;
  status: "merged" | "blocked" | "failed";
  node_count: number;
  failures: number;
  evidence_keys: string[];
}

const runsDir = (cwd: string) => join(cwd, ".graphkit", "runs");
const activeFile = (cwd: string) => join(runsDir(cwd), ".active");
const indexFile = (cwd: string) => join(runsDir(cwd), "index.jsonl");

/** Raw `.active` state: the pointer file's target dir and whether that dir
 *  still exists. null when no pointer file (or it is empty). A dangling
 *  pointer records a run whose dir was deleted/crashed away — the ledger
 *  treats it as no active run, but the stale file would still deadlock a
 *  fresh `startRun` (atomic "wx" write hits EEXIST). */
export function activeRunPointer(cwd: string): { dir: string; dangling: boolean } | null {
  const f = activeFile(cwd);
  if (!existsSync(f)) return null;
  const dir = readFileSync(f, "utf-8").trim();
  if (!dir) return null;
  return { dir, dangling: !existsSync(dir) };
}

/** Absolute path of the live run dir, or null when no run is active. */
export function activeRun(cwd: string): string | null {
  const p = activeRunPointer(cwd);
  return p && !p.dangling ? p.dir : null;
}

/** Drop the active-run pointer (idempotent). Takeover clears it only when it names the taken run. */
export function clearActiveRun(cwd: string): void {
  rmSync(activeFile(cwd), { force: true });
}

/** Record a takeover stamp; the next startRun consumes it into meta.takes_over. */
export function stampTakeover(cwd: string, oldRunId: string): void {
  mkdirSync(runsDir(cwd), { recursive: true });
  writeFileSync(join(runsDir(cwd), ".takeover"), oldRunId);
}

/** Graph path recorded by startRun on the active run, or null (no run / legacy meta). */
export function activeRunGraph(cwd: string): string | null {
  const dir = activeRun(cwd);
  if (!dir) return null;
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")) as { graph_path?: string };
    return typeof meta.graph_path === "string" && meta.graph_path ? meta.graph_path : null;
  } catch {
    return null; // unreadable meta falls back to the caller's default graph
  }
}

function safeGraphName(name: string): string {
  return name.replace(/\.\./g, "-").replace(/[\\/]/g, "-");
}

function graphName(graphPath: string): string {
  try {
    const parsed = YAML.parse(readFileSync(graphPath, "utf-8"));
    const name = parsed?.metadata?.name;
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    /* fall through to filename */
  }
  return basename(graphPath).replace(/\.ya?ml$/, "");
}

/** run id = YYYYMMDD-HHMMSS-<graphname>, derived from the start timestamp. */
function runId(now: string, name: string): string {
  const stamp = now.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${name}`;
}

export function startRun(
  cwd: string,
  graphPath: string,
  now = new Date().toISOString(),
  resumes?: string,
): { id: string; dir: string; graph_sha256: string } {
  const existing = activeRun(cwd);
  if (existing) throw new GraphKitError("RUN_ACTIVE", `run already active at ${existing}; run \`gk run end\` first`);
  // A .active naming a deleted run dir is a dangling pointer: the ledger
  // already treats a vanished dir as no active run, so drop the stale file
  // here instead of deadlocking the atomic write below (EEXIST with no live
  // run to name — the "unreadable .active" deadlock).
  if (existsSync(activeFile(cwd))) clearActiveRun(cwd);
  const resolved = isAbsolute(graphPath) ? graphPath : resolve(cwd, graphPath);
  if (!existsSync(resolved)) throw new GraphKitError("GRAPH_NOT_FOUND", graphPath);

  const raw = readFileSync(resolved, "utf-8");
  const name = safeGraphName(graphName(resolved));

  const baseId = runId(now, name);
  let id = baseId;
  let dir = join(runsDir(cwd), id);
  let suffix = 2;
  while (existsSync(dir)) {
    id = `${baseId}-${suffix++}`;
    dir = join(runsDir(cwd), id);
  }
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, "trace.jsonl"), "");
  const meta: Record<string, unknown> = {
    id,
    graph: name,
    graph_path: resolved,
    graph_sha256: createHash("sha256").update(raw).digest("hex"),
    fingerprint: fingerprint(cwd),
    started_at: now,
  };
  // A prior `run take` left a takeover stamp: the fresh run records it as provenance.
  // Read+merge now; the stamp file is deleted only after the run is live (below) so a
  // failed start (RUN_ACTIVE race) never destroys the provenance.
  const takeoverFile = join(runsDir(cwd), ".takeover");
  const takesOver = existsSync(takeoverFile) ? readFileSync(takeoverFile, "utf-8").trim() || null : null;
  if (takesOver) meta.takes_over = takesOver;
  if (resumes) meta.resumes = resumes;
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  // GBrain layout: compiled truth above the rule, append-only timeline below.
  writeFileSync(
    join(dir, "run.md"),
    [
      `# Run ${id}`,
      "",
      `- graph: ${name}`,
      `- started_at: ${now}`,
      ...(resumes ? [`- resumes: ${resumes}`] : []),
      "- status: running",
      "",
      "---",
      "",
      "## Timeline",
      "",
    ].join("\n"),
  );
  try {
    writeFileSync(activeFile(cwd), dir, { flag: "wx" }); // atomic: no check-then-write window
  } catch (e) {
    rmSync(dir, { recursive: true, force: true }); // don't orphan the fresh run dir
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new GraphKitError("RUN_ACTIVE", `run already active at ${activeRun(cwd) ?? "(unreadable .active)"}`);
    throw e;
  }
  if (takesOver) rmSync(takeoverFile, { force: true }); // consume: run is live, provenance committed
  return { id, dir, graph_sha256: meta.graph_sha256 as string };
}

export function appendNode(cwd: string, line: Omit<TraceLine, "at">, now = new Date().toISOString()) {
  const dir = activeRun(cwd);
  // Strict on purpose: an orphan trace line silently corrupts pattern statistics.
  if (!dir) throw new GraphKitError("NO_ACTIVE_RUN", "start a run with `gk run start` before recording nodes");
  const entry: TraceLine = { at: now, ...line };
  appendFileSync(join(dir, "trace.jsonl"), `${JSON.stringify(entry)}\n`);
  const detail = [line.agent, line.duration_ms == null ? null : `${line.duration_ms}ms`, line.notes]
    .filter(Boolean)
    .join(" · ");
  appendFileSync(join(dir, "run.md"), `- \`${line.node}\` ${line.status}${detail ? ` — ${detail}` : ""}\n`);
  return { run: basename(dir), node: line.node };
}

export interface AdvisorEvent {
  at: string;
  node: string;
  round: number;
  tier: string;
  streak: number | null;
}

export function appendAdvisor(
  cwd: string,
  ev: Omit<AdvisorEvent, "at">,
  now = new Date().toISOString(),
): { event: AdvisorEvent; run: string } {
  const dir = activeRun(cwd);
  // Same strictness as appendNode: an advisor event with no live run is a bug, not noise.
  if (!dir) throw new GraphKitError("NO_ACTIVE_RUN", "start a run with `gk run start` before recording advisor events");
  const event: AdvisorEvent = { at: now, ...ev };
  appendFileSync(join(dir, "advisor.jsonl"), `${JSON.stringify(event)}\n`);
  return { event, run: basename(dir) };
}

/** Pre-dispatch intent record — written BEFORE launch so a crashed run can
 *  distinguish "dispatched but quiet" from "never dispatched" on resume. */
export function appendDispatch(
  cwd: string,
  line: Omit<DispatchLine, "at">,
  now = new Date().toISOString(),
): { run: string; node: string } {
  const dir = activeRun(cwd);
  if (!dir) throw new GraphKitError("NO_ACTIVE_RUN", "start a run with `gk run start` before recording dispatches");
  // A junk pid poisons `take` forever (pid 0 signals our own process group and
  // always looks alive), so dispatch.jsonl only ever holds real pids.
  if (line.pid != null && (!Number.isInteger(line.pid) || line.pid <= 0))
    throw new GraphKitError("BAD_PID", `--pid must be a positive integer, got ${line.pid}`);
  const entry: DispatchLine = { at: now, ...line };
  appendFileSync(join(dir, "dispatch.jsonl"), `${JSON.stringify(entry)}\n`);
  return { run: basename(dir), node: line.node };
}

export function readDispatches(cwd: string, id: string): DispatchLine[] {
  const f = join(runsDir(cwd), id, "dispatch.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as DispatchLine];
      } catch {
        return [];
      }
    });
}

/** Record integration as an append-only event — `{node, status:"landed",
 *  commit}` on its own line — refused unless the node's latest trace line is
 *  `ok`. Appending is the point: the read-modify-write this replaced clobbered
 *  any line another writer appended between its read and its rewrite. */
export function landNode(cwd: string, node: string, commit: string, now = new Date().toISOString()) {
  const dir = activeRun(cwd);
  if (!dir) throw new GraphKitError("NO_ACTIVE_RUN", "start a run before landing nodes");
  const id = basename(dir);
  // The stamp ties the node to its integration commit — a non-sha silently
  // poisons the audit trail the run report is built on.
  if (!/^[0-9a-f]{4,40}$/i.test(commit))
    throw new GraphKitError("BAD_COMMIT", `--commit must be a 4-40 char hex sha, got "${commit}"`);
  const trace = readTrace(cwd, id);
  // Latest status wins: a node whose most recent round failed is not landable,
  // even if an earlier `ok` line exists — a stale-ok stamp asserts an
  // integration that never happened. Landed events carry no round result, so
  // the scan looks through them (a re-land after a re-ok re-appends).
  let last: TraceLine | undefined;
  for (let i = trace.length - 1; i >= 0; i--) {
    const t = trace[i];
    if (t.node === node && isNodeLine(t)) {
      last = t;
      break;
    }
  }
  if (!last) throw new GraphKitError("LAND_NOT_OK", `no trace line for node "${node}" in run ${id}`);
  if (last.status !== "ok")
    throw new GraphKitError(
      "LAND_NOT_OK",
      `latest trace for node "${node}" in run ${id} is "${last.status}", not ok`,
    );
  const event: LandEvent = { at: now, node, status: "landed", commit };
  appendFileSync(join(dir, "trace.jsonl"), `${JSON.stringify(event)}\n`);
  return { run: id, node };
}

export function readAdvisorEvents(cwd: string, id: string): AdvisorEvent[] {
  const f = join(runsDir(cwd), id, "advisor.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AdvisorEvent];
      } catch {
        return []; // skip a torn line rather than abort the whole scan
      }
    });
}

export function readTrace(cwd: string, id: string): TraceEntry[] {
  const f = join(runsDir(cwd), id, "trace.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as TraceEntry];
      } catch {
        return []; // skip a torn line rather than abort the whole scan
      }
    });
}

export function readRunIndex(cwd: string): RunIndexLine[] {
  const f = indexFile(cwd);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as RunIndexLine];
      } catch {
        return [];
      }
    });
}

export function endRun(cwd: string, status: RunIndexLine["status"], now = new Date().toISOString()): RunIndexLine {
  const dir = activeRun(cwd);
  if (!dir) throw new GraphKitError("NO_ACTIVE_RUN", "nothing to end");
  const id = basename(dir);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
  const trace = readTrace(cwd, id);
  // Landed events are bookkeeping, not node rounds: they must not inflate
  // node_count or leak into evidence_keys.
  const nodes = trace.filter(isNodeLine);

  const summary: RunIndexLine = {
    id,
    graph: meta.graph,
    graph_sha256: meta.graph_sha256,
    started_at: meta.started_at,
    ended_at: now,
    status,
    node_count: nodes.length,
    failures: nodes.filter((t) => t.status === "fail").length,
    evidence_keys: Array.from(new Set(nodes.flatMap((t) => t.evidence))).sort(),
  };

  appendFileSync(indexFile(cwd), `${JSON.stringify(summary)}\n`);
  const md = readFileSync(join(dir, "run.md"), "utf-8").replace(
    "- status: running",
    [
      `- status: ${status}`,
      `- ended_at: ${now}`,
      `- nodes: ${summary.node_count}`,
      `- failures: ${summary.failures}`,
    ].join("\n"),
  );
  writeFileSync(join(dir, "run.md"), md);
  rmSync(activeFile(cwd), { force: true });
  return summary;
}

/** Run ids present on disk, oldest first — ids are timestamp-prefixed so lexical == chronological. */
export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[\w.-]+$/;
export function listRunIds(cwd: string): string[] {
  const d = runsDir(cwd);
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory() && RUN_ID_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort();
}

export interface RunMeta {
  id: string;
  graph: string;
  graph_path: string;
  graph_sha256: string;
  started_at: string;
  ended_at?: string;
  resumes?: string;
}
export function readRunMeta(cwd: string, id: string): RunMeta {
  const file = join(runsDir(cwd), id, "meta.json");
  if (!RUN_ID_PATTERN.test(id) || !existsSync(file))
    throw new GraphKitError("RESUME_RUN_NOT_FOUND", `no run "${id}" under ${runsDir(cwd)}`);
  return JSON.parse(readFileSync(file, "utf-8")) as RunMeta;
}
