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
 *
 * `loops[].no_progress_similarity` softens the byte-exact fingerprint with a
 * normalized failure signature: evidence text is stripped of paths,
 * file:line positions, digests, numbers/ids and timestamps, then compared
 * between consecutive rounds by Jaccard similarity over word 3-shingles. A
 * similarity >= the configured threshold counts toward the no-progress
 * streak exactly like an identical fingerprint — a loop failing the same
 * way with different temp paths or line numbers still trips the breaker.
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
  /** Trailing consecutive rounds (including this one) with no progress —
   * identical fingerprints, or signatures similar enough when
   * `no_progress_similarity` is configured. */
  repeated: number;
  no_progress_limit: number | null;
  /** Jaccard similarity between this round's and the previous round's
   * failure signatures — null on the first round, when fingerprints
   * matched exactly, or when similarity matching is not configured. */
  signature_similarity: number | null;
  /** The configured `no_progress_similarity` this round was judged against. */
  similarity_threshold: number | null;
  no_progress_exhausted: boolean;
  /** When stop_reason is "no_progress": whether the streak tripped on an
   * identical fingerprint or on signature similarity. */
  no_progress_via: "fingerprint" | "similarity" | null;
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
  /** Normalized failure signature (see normalizeFailureText) recorded when
   * the group configures `no_progress_similarity`; absent otherwise. */
  signature?: string;
  /** Jaccard similarity of `signature` vs the previous journal line's —
   * null on the first round or when fingerprints matched exactly. */
  signature_similarity?: number | null;
  /** The `no_progress_similarity` threshold in force when this line was written. */
  similarity_threshold?: number | null;
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

/** Bound on a stored group signature — keeps round journals small while
 * leaving enough text for shingle overlap to be meaningful. */
const SIGNATURE_MAX_CHARS = 16_384;
/** Shingle width for the Jaccard comparison, in space-separated words. */
const SHINGLE_WORDS = 3;

/** Canonicalize failure text for cross-round comparison: lowercase, strip
 * the incidental tokens that legitimately differ between identical
 * failures — timestamps, file:line positions, absolute paths, hex digests,
 * alnum ids and bare numbers — and collapse whitespace to single spaces.
 * Two rounds failing "the same way" with different temp dirs, ports or
 * line numbers produce the same normalized text. Order matters: more
 * specific patterns run before the bare-number catch-all. */
export function normalizeFailureText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?/g, " <ts> ")
    .replace(/\b\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\b/g, " <ts> ")
    .replace(/(\S+?):(\d+)(:\d+)?/g, "$1") // file:line(:col) — keep the stem
    .replace(/(?:^|\s)\/[^\s]+/g, " <path> ") // absolute paths
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, " <id> ")
    .replace(/\b[0-9a-f]{7,}\b/g, " <id> ") // shas and hex digests
    .replace(/\b(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{6,}\b/g, " <id> ") // mixed alnum ids
    .replace(/\b\d+[a-z0-9]*/g, " <n> ") // numbers and digit-led tokens (404, 30s)
    .replace(/\s+/g, " ")
    .trim();
}

/** Word-shingle set of a normalized signature. Signatures shorter than
 * SHINGLE_WORDS degrade to a plain token set so tiny texts still compare. */
function shingles(text: string): Set<string> {
  const words = text.split(" ").filter((w) => w.length > 0);
  if (words.length < SHINGLE_WORDS) return new Set(words);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) out.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  return out;
}

/** Jaccard similarity over the word-3-shingle sets of two normalized
 * signatures: 1.0 identical sets, 0.0 disjoint. Two empty signatures count
 * as identical (nothing to distinguish). */
export function signatureSimilarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Canonical group signature for one round — the same inputs the
 * fingerprint hashes (per-node last statuses, per-key evidence), rendered
 * as comparable text: sorted `node <id> status <status>` lines then sorted
 * `evidence <key>\n<normalized content>` blocks. */
function buildSignature(statuses: ReadonlyMap<string, string>, contents: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  for (const [node, status] of [...statuses.entries()].sort()) parts.push(`node ${node} status ${status}`);
  for (const [key, content] of [...contents.entries()].sort()) parts.push(`evidence ${key}\n${content}`);
  return parts.join("\n").slice(0, SIGNATURE_MAX_CHARS);
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
  const threshold = group.no_progress_similarity ?? null;
  // Normalized evidence contents — only collected when similarity matching is
  // on, so the default path reads the same bytes and journals identically.
  const contents = new Map<string, string>();
  for (const line of window) {
    statuses.set(line.node, line.status);
    for (const key of line.evidence) {
      const f = join(cwd, evidenceDir, `${key}.md`);
      if (!existsSync(f)) {
        digests.set(key, "missing");
        if (threshold != null) contents.set(key, "missing");
        continue;
      }
      const bytes = readFileSync(f);
      digests.set(key, createHash("sha256").update(bytes).digest("hex"));
      if (threshold != null) contents.set(key, normalizeFailureText(bytes.toString("utf-8")));
    }
  }
  const signature = JSON.stringify({
    statuses: [...statuses.entries()].sort(),
    evidence: [...digests.entries()].sort(),
  });
  const fingerprint = createHash("sha256").update(signature).digest("hex");
  const groupSignature = threshold != null ? buildSignature(statuses, contents) : null;

  // Does this round "match" the previous one? Exact fingerprint first; only
  // when that differs do we fall back to signature similarity (which needs
  // the previous line's stored signature — absent on legacy journals).
  const prev = journal.length > 0 ? journal[journal.length - 1] : null;
  let signature_similarity: number | null = null;
  let matchedBy: "fingerprint" | "similarity" | null = null;
  if (prev) {
    if (prev.fingerprint === fingerprint) {
      matchedBy = "fingerprint";
    } else if (threshold != null && prev.signature != null && groupSignature != null) {
      signature_similarity = signatureSimilarity(prev.signature, groupSignature);
      if (signature_similarity >= threshold) matchedBy = "similarity";
    }
  }

  // Streak = current round + trailing journal lines that each matched their
  // own predecessor — identical fingerprint, or a stored signature_similarity
  // at/over the current threshold. Pure-fingerprint history reduces exactly
  // to the old consecutive-identical count.
  const lineMatched = (i: number) => {
    const sim = journal[i].signature_similarity;
    return (
      journal[i].fingerprint === journal[i - 1].fingerprint || (threshold != null && sim != null && sim >= threshold)
    );
  };
  let repeated = 1;
  if (matchedBy) {
    repeated++; // the last journal line joins the streak because current matched it
    for (let i = journal.length - 1; i >= 1 && lineMatched(i); i--) repeated++;
  }

  const limit = group.no_progress_limit ?? null;
  const no_progress_exhausted = limit != null && repeated >= limit;
  const round = journal.length + 1;
  const stop_reason = no_progress_exhausted ? "no_progress" : round >= group.max_rounds ? "max_rounds" : null;
  const no_progress_via = stop_reason === "no_progress" ? matchedBy : null;

  mkdirSync(roundsDir(cwd, id), { recursive: true });
  const line: JournalLine = {
    round,
    at: now,
    fingerprint,
    up_to: upTo + window.length,
    signature_similarity,
    similarity_threshold: threshold,
    ...(groupSignature != null ? { signature: groupSignature } : {}),
  };
  appendFileSync(join(roundsDir(cwd, id), `${groupIdx}.jsonl`), `${JSON.stringify(line)}\n`);
  appendFileSync(
    join(cwd, ".graphkit", "runs", id, "run.md"),
    `- \`round ${round}\` group ${groupIdx} · fp ${fingerprint.slice(0, 12)}${repeated > 1 ? ` · ×${repeated}` : ""}${
      signature_similarity != null ? ` · sim ${signature_similarity.toFixed(3)}` : ""
    }${stop_reason ? ` · ${stop_reason.toUpperCase()}` : ""}\n`,
  );

  return {
    run: id,
    group: groupIdx,
    node: null,
    nodes: [...group.nodes],
    round,
    fingerprint,
    repeated,
    signature_similarity,
    similarity_threshold: threshold,
    no_progress_limit: limit,
    no_progress_exhausted,
    no_progress_via,
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
  const line: JournalLine = {
    round,
    at: now,
    fingerprint,
    up_to: upTo + window.length,
    signature_similarity: null,
    similarity_threshold: null,
  };
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
    signature_similarity: null,
    similarity_threshold: null,
    no_progress_limit: null,
    no_progress_exhausted: false,
    no_progress_via: null,
    max_rounds: opts.maxRounds,
    stop_reason,
  };
}
