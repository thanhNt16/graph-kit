import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";

export interface TraceLine {
  at: string;
  node: string;
  wave: number | null;
  agent: string | null;
  model: string | null;
  status: "ok" | "fail";
  evidence: string[];
  duration_ms: number | null;
  notes: string | null;
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

/** Absolute path of the live run dir, or null when no run is active. */
export function activeRun(cwd: string): string | null {
  const f = activeFile(cwd);
  if (!existsSync(f)) return null;
  const dir = readFileSync(f, "utf-8").trim();
  return dir && existsSync(dir) ? dir : null;
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

export function startRun(cwd: string, graphPath: string, now = new Date().toISOString()): { id: string; dir: string } {
  const existing = activeRun(cwd);
  if (existing) throw new Error(`RUN_ACTIVE: run already active at ${existing}; run \`gk run end\` first`);
  if (!existsSync(graphPath)) throw new Error(`GRAPH_NOT_FOUND: ${graphPath}`);

  const raw = readFileSync(graphPath, "utf-8");
  const name = safeGraphName(graphName(graphPath));
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
  writeFileSync(
    join(dir, "meta.json"),
    `${JSON.stringify({ id, graph: name, graph_sha256: createHash("sha256").update(raw).digest("hex"), started_at: now }, null, 2)}\n`,
  );
  // GBrain layout: compiled truth above the rule, append-only timeline below.
  writeFileSync(
    join(dir, "run.md"),
    [
      `# Run ${id}`,
      "",
      `- graph: ${name}`,
      `- started_at: ${now}`,
      "- status: running",
      "",
      "---",
      "",
      "## Timeline",
      "",
    ].join("\n"),
  );
  writeFileSync(activeFile(cwd), dir);
  return { id, dir };
}

export function appendNode(cwd: string, line: Omit<TraceLine, "at">, now = new Date().toISOString()) {
  const dir = activeRun(cwd);
  // Strict on purpose: an orphan trace line silently corrupts pattern statistics.
  if (!dir) throw new Error("NO_ACTIVE_RUN: start a run with `gk run start` before recording nodes");
  const entry: TraceLine = { at: now, ...line };
  appendFileSync(join(dir, "trace.jsonl"), `${JSON.stringify(entry)}\n`);
  const detail = [line.agent, line.duration_ms == null ? null : `${line.duration_ms}ms`, line.notes]
    .filter(Boolean)
    .join(" · ");
  appendFileSync(join(dir, "run.md"), `- \`${line.node}\` ${line.status}${detail ? ` — ${detail}` : ""}\n`);
  return { run: basename(dir), node: line.node };
}

export function readTrace(cwd: string, id: string): TraceLine[] {
  const f = join(runsDir(cwd), id, "trace.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as TraceLine];
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
  if (!dir) throw new Error("NO_ACTIVE_RUN: nothing to end");
  const id = basename(dir);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
  const trace = readTrace(cwd, id);

  const summary: RunIndexLine = {
    id,
    graph: meta.graph,
    graph_sha256: meta.graph_sha256,
    started_at: meta.started_at,
    ended_at: now,
    status,
    node_count: trace.length,
    failures: trace.filter((t) => t.status === "fail").length,
    evidence_keys: Array.from(new Set(trace.flatMap((t) => t.evidence))).sort(),
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
export function listRunIds(cwd: string): string[] {
  const d = runsDir(cwd);
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
