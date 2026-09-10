import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import { GraphSchema } from "../schemas/graph.schema.js";
import { activeRun, activeRunGraph, readTrace, type TraceLine } from "./ledger.js";

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
  group: number;
  nodes: string[];
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

interface JournalLine {
  round: number;
  at: string;
  fingerprint: string;
  /** Group trace lines consumed through this round (append-only trace ⇒ stable). */
  up_to: number;
}

const roundsDir = (cwd: string, id: string) => join(cwd, ".graphkit", "runs", id, "rounds");

function readJournal(cwd: string, id: string, group: number): JournalLine[] {
  const f = join(roundsDir(cwd, id), `${group}.jsonl`);
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

export function recordRound(cwd: string, groupIdx: number, now = new Date().toISOString()): RoundResult {
  const dir = activeRun(cwd);
  if (!dir) throw new Error("NO_ACTIVE_RUN: start a run with `gk run start` before recording rounds");
  const id = basename(dir);

  // Tier source mirrors the advisor path: the ACTIVE RUN's recorded graph.
  const graphPath = activeRunGraph(cwd) ?? join(cwd, "graph.yaml");
  const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(graphPath, "utf-8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`SCHEMA_INVALID: ${graphPath} — ${issues}`);
  }
  const group = parsed.data.loops?.[groupIdx];
  if (!group) throw new Error(`LOOP_GROUP_MISSING: graph has no loop group ${groupIdx}`);
  const evidenceDir = parsed.data.outputs?.evidence_dir ?? ".graphkit/evidence/";

  const journal = readJournal(cwd, id, groupIdx);
  const upTo = journal.length > 0 ? journal[journal.length - 1].up_to : 0;

  // Window: this round's slice of the group's trace lines.
  const groupLines = readTrace(cwd, id).filter((l: TraceLine) => group.nodes.includes(l.node));
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
