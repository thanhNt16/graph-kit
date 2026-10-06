import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import { formatZodIssues } from "../cli/diagnostics.js";
import { resolveGraphPath } from "../cli/graph-resolve.js";
import { GraphKitError } from "../errors.js";
import { GraphSchema } from "../schemas/graph.schema.js";
import { activeRun, isNodeLine, readTrace, type TraceLine } from "./ledger.js";

/**
 * Durable loop-group round tracking (graph `loops:` spans).
 *
 * One journal line per completed round lives at
 * `.graphkit/runs/<id>/rounds/<group>.jsonl`, so round counts and
 * no-progress streaks survive restarts and are derived from the trace +
 * evidence bytes, never from orchestrator prose. The fingerprint is
 * sha256 over the group's per-node last statuses and the sha256 of every
 * evidence key written this round — identical failing state therefore
 * fingerprints identically without trusting any model output.
 */

export interface RoundResult {
  run: string;
  /** Graph loop-group index, or null for a per-node (`loop.enabled`) round. */
  group: number | null;
  /** Node id for per-node rounds, else null. */
  node: string | null;
  nodes: string[];
  /** Journal round number (1-based, durable across resumes). */
  round: number;
  fingerprint: string;
  /** Trailing consecutive rounds (including this one) sharing a fingerprint. */
  repeated: number;
  no_progress_limit: number | null;
  no_progress_exhausted: boolean;
  max_rounds: number;
  /** What the orchestrator must do after this round: fail the loop or keep going. */
  stop_reason: "no_progress" | "max_rounds" | null;
}

export interface JournalLine {
  round: number;
  at: string;
  fingerprint: string;
  /** Group trace lines consumed through this round (append-only trace ⇒ stable). */
  up_to: number;
}


const roundsDir = (cwd: string, id: string) => join(cwd, ".graphkit", "runs", id, "rounds");
function readJournal(cwd: string, id: string, stem: string): JournalLine[] {
  const f = join(roundsDir(cwd, id), `${stem}.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as JournalLine];
      } catch {
        return []; // skip a torn line rather than abort the whole scan
      }
    });
}

/** All round journals of a run — graph groups (numeric stems, ascending) then
 * per-node loop journals (`n-<nodeId>`, alphabetical) — the read-only view
 * `gk run analyze` audits. */
export function readRoundJournals(
  cwd: string,
  id: string,
): { group: number | null; node: string | null; lines: JournalLine[] }[] {
  const dir = roundsDir(cwd, id);
  if (!existsSync(dir)) return [];
  const stems = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f): { stem: string; group: number | null; node: string | null } => {
      const stem = f.slice(0, -".jsonl".length);
      return /^\d+$/.test(stem)
        ? { stem, group: Number(stem), node: null }
        : { stem, group: null, node: stem.startsWith("n-") ? stem.slice(2) : stem };
    })
    .filter((j) => j.group !== null || j.node !== null);
  const graphJournals = stems.filter((j) => j.group !== null).sort((a, b) => a.group! - b.group!);
  const nodeJournals = stems.filter((j) => j.group === null).sort((a, b) => a.stem.localeCompare(b.stem));
  return [...graphJournals, ...nodeJournals].map((j) => ({
    group: j.group,
    node: j.node,
    lines: readJournal(cwd, id, j.stem),
  }));
}

export function recordRound(cwd: string, groupIdx: number, now = new Date().toISOString()): RoundResult {
  const dir = activeRun(cwd);
  if (!dir) throw new GraphKitError("NO_ACTIVE_RUN", "start a run with `gk run start` before recording rounds");
  const id = basename(dir);

  // Tier source: the ONE graph resolver — the active run's recorded graph, then
  // the session pointer, then ./graph.yaml. Schema errors keep this module's
  // own shape (Task 2 owns error-envelope migration).
  const graphPath = resolveGraphPath(cwd).path;
  const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(graphPath, "utf-8")));
  if (!parsed.success) {
    throw new GraphKitError("SCHEMA_INVALID", `${graphPath} failed schema validation`, {
      issues: formatZodIssues(parsed.error, GraphSchema),
    });
  }
  const group = parsed.data.loops?.[groupIdx];
  if (!group) throw new GraphKitError("LOOP_GROUP_MISSING", `graph has no loop group ${groupIdx}`);
  const evidenceDir = parsed.data.outputs?.evidence_dir ?? ".graphkit/evidence/";

  const journal = readJournal(cwd, id, String(groupIdx));
  const upTo = journal.length > 0 ? journal[journal.length - 1].up_to : 0;

  // Window: this round's slice of the group's trace lines.
  const groupLines = readTrace(cwd, id)
    .filter(isNodeLine)
    .filter((l: TraceLine) => group.nodes.includes(l.node));
  const window = groupLines.slice(upTo);

  const statuses = new Map<string, string>();
  const digests = new Map<string, string>();
  for (const node of group.nodes) statuses.set(node, "none");
  for (const line of window) {
    statuses.set(line.node, line.status);
    for (const key of line.evidence) {
      const f = join(cwd, evidenceDir, `${key}.md`);
      digests.set(key, existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : "missing");
    }
  }
  const signature = JSON.stringify({
    statuses: [...statuses.entries()].sort(),
    evidence: [...digests.entries()].sort(),
  });
  const fingerprint = createHash("sha256").update(signature).digest("hex");

  let repeated = 1;
  for (let i = journal.length - 1; i >= 0 && journal[i].fingerprint === fingerprint; i--) repeated++;

  const limit = group.no_progress_limit ?? null;
  const no_progress_exhausted = limit != null && repeated >= limit;
  const round = journal.length + 1;
  const stop_reason = no_progress_exhausted ? "no_progress" : round >= group.max_rounds ? "max_rounds" : null;

  mkdirSync(roundsDir(cwd, id), { recursive: true });
  const line: JournalLine = { round, at: now, fingerprint, up_to: upTo + window.length };
  appendFileSync(join(roundsDir(cwd, id), `${groupIdx}.jsonl`), `${JSON.stringify(line)}\n`);
  appendFileSync(
    join(cwd, ".graphkit", "runs", id, "run.md"),
    `- \`round ${round}\` group ${groupIdx} · fp ${fingerprint.slice(0, 12)}${repeated > 1 ? ` · ×${repeated}` : ""}${
      stop_reason ? ` · ${stop_reason.toUpperCase()}` : ""
    }\n`,
  );

  return {
    run: id,
    group: groupIdx,
    node: null,
    nodes: [...group.nodes],
    round,
    fingerprint,
    repeated,
    no_progress_limit: limit,
    no_progress_exhausted,
    max_rounds: group.max_rounds,
    stop_reason,
  };
}

/** Per-node loop rounds (`loop.enabled`): the same durable journal format as
 * graph groups, keyed `n-<nodeId>.jsonl` so numeric journals stay graph-loop
 * only and readers can tell the two apart. Fingerprint and repeated-streak
 * semantics are identical to recordRound; per-node loops carry no
 * no_progress policy, so stop_reason is max_rounds-only. */
export function recordNodeRound(
  cwd: string,
  nodeId: string,
  opts: { maxRounds: number; evidenceDir?: string },
  now = new Date().toISOString(),
): RoundResult {
  const dir = activeRun(cwd);
  if (!dir) throw new GraphKitError("NO_ACTIVE_RUN", "start a run with `gk run start` before recording rounds");
  const id = basename(dir);

  const stem = `n-${nodeId}`;
  const journal = readJournal(cwd, id, stem);
  const upTo = journal.length > 0 ? journal[journal.length - 1].up_to : 0;
  const window = readTrace(cwd, id)
    .filter(isNodeLine)
    .filter((l: TraceLine) => l.node === nodeId)
    .slice(upTo);

  const statuses = new Map<string, string>([[nodeId, window.length > 0 ? window[window.length - 1].status : "none"]]);
  const digests = new Map<string, string>();
  const evidenceDir = opts.evidenceDir ?? ".graphkit/evidence";
  for (const line of window) {
    for (const key of line.evidence) {
      const f = join(cwd, evidenceDir, `${key}.md`);
      digests.set(key, existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : "missing");
    }
  }
  const signature = JSON.stringify({
    statuses: [...statuses.entries()].sort(),
    evidence: [...digests.entries()].sort(),
  });
  const fingerprint = createHash("sha256").update(signature).digest("hex");

  let repeated = 1;
  for (let i = journal.length - 1; i >= 0 && journal[i].fingerprint === fingerprint; i--) repeated++;

  const round = journal.length + 1;
  const stop_reason = round >= opts.maxRounds ? "max_rounds" : null;

  mkdirSync(roundsDir(cwd, id), { recursive: true });
  const line: JournalLine = { round, at: now, fingerprint, up_to: upTo + window.length };
  appendFileSync(join(roundsDir(cwd, id), `${stem}.jsonl`), `${JSON.stringify(line)}\n`);
  appendFileSync(
    join(cwd, ".graphkit", "runs", id, "run.md"),
    `- \`round ${round}\` node ${nodeId} · fp ${fingerprint.slice(0, 12)}${repeated > 1 ? ` · ×${repeated}` : ""}${
      stop_reason ? ` · ${stop_reason.toUpperCase()}` : ""
    }\n`,
  );

  return {
    run: id,
    group: null,
    node: nodeId,
    nodes: [nodeId],
    round,
    fingerprint,
    repeated,
    no_progress_limit: null,
    no_progress_exhausted: false,
    max_rounds: opts.maxRounds,
    stop_reason,
  };
}
