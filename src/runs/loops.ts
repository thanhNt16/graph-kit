import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import { formatZodIssues } from "../cli/diagnostics.js";
import { resolveGraphPath } from "../cli/graph-resolve.js";
import { GraphKitError } from "../errors.js";
import { fingerprint } from "../evidence/fingerprint.js";
import { freshnessOf, parseMarker } from "../evidence/marker.js";
import { GraphSchema, type LoopGroup, type LoopKind } from "../schemas/graph.schema.js";
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
  /** The group's declared kind — "judged" for legacy journals and per-node rounds. */
  kind: LoopKind;
  /** Deterministic check evaluated this round (polling/counting), else null. */
  check: Record<string, unknown> | null;
  /** What the orchestrator must do after this round. "condition_met" is the
   *  successful deterministic exit; the rest are failures/timeouts. */
  stop_reason: "no_progress" | "max_rounds" | "condition_met" | "poll_timeout" | null;
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
  /** Absent on legacy journals — readers default "judged". */
  kind?: LoopKind;
  /** The deterministic check result for mechanical kinds (poll evaluation,
   *  exit_when predicate detail); judged rounds leave it absent. */
  check?: Record<string, unknown>;
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

/** Per-key deterministic evidence state — mirrors the gate's reading (ADR-002
 *  basename contract): the file must exist, carry non-whitespace content, and
 *  be neither superseded nor stale against the current repo fingerprint.
 *  Markerless/unfingerprinted artifacts are "unknown" and satisfy the check —
 *  the same non-strict reading the gate applies (strict is a gate concern;
 *  a loop kind promises deterministic evaluation, not provenance policy). */
export type EvidenceState = "missing" | "empty" | "superseded" | "stale" | "foreign" | "unknown" | "fresh";

function evidenceState(cwd: string, evidenceDir: string, key: string): { state: EvidenceState; satisfied: boolean } {
  const p = join(cwd, evidenceDir, `${key}.md`);
  if (!existsSync(p)) return { state: "missing", satisfied: false };
  const content = readFileSync(p, "utf-8");
  if (content.trim().length === 0) return { state: "empty", satisfied: false };
  const marker = parseMarker(content);
  if (marker?.superseded) return { state: "superseded", satisfied: false };
  const fresh = freshnessOf(marker, fingerprint(cwd));
  if (fresh === "stale" || fresh === "foreign") return { state: fresh, satisfied: false };
  return { state: fresh, satisfied: true };
}

interface ResolvedGroup {
  id: string;
  group: LoopGroup;
  evidenceDir: string;
}

/** Active run + recorded graph + group lookup — shared by round/poll paths. */
function resolveGroup(cwd: string, groupIdx: number): ResolvedGroup {
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
  return { id, group, evidenceDir: parsed.data.outputs?.evidence_dir ?? ".graphkit/evidence/" };
}

function recordGroupRound(cwd: string, groupIdx: number, { id, group, evidenceDir }: ResolvedGroup, now: string) {
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
  const fp = createHash("sha256").update(signature).digest("hex");
  const groupSignature = threshold != null ? buildSignature(statuses, contents) : null;

  // Does this round "match" the previous one? Exact fingerprint first; only
  // when that differs do we fall back to signature similarity (which needs
  // the previous line's stored signature — absent on legacy journals).
  const prev = journal.length > 0 ? journal[journal.length - 1] : null;
  let signature_similarity: number | null = null;
  let matchedBy: "fingerprint" | "similarity" | null = null;
  if (prev) {
    if (prev.fingerprint === fp) {
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
  const kind = group.kind;

  // Mechanical kinds evaluate their declared deterministic check before any
  // bound applies — a satisfied condition is the successful exit
  // ("condition_met") and wins over circuit breakers firing the same round.
  let check: Record<string, unknown> | null = null;
  let stop_reason: RoundResult["stop_reason"] = null;
  if (kind === "counting") {
    const exit = group.exit_when!;
    const perKey: Record<string, EvidenceState> = {};
    let all_fresh = exit.evidence_all_fresh != null;
    for (const key of exit.evidence_all_fresh ?? []) {
      const s = evidenceState(cwd, evidenceDir, key);
      perKey[key] = s.state;
      if (!s.satisfied) all_fresh = false;
    }
    const satisfied = all_fresh || (exit.rounds_eq != null && round >= exit.rounds_eq);
    check = {
      predicate: "exit_when",
      evidence: perKey,
      all_fresh,
      rounds_eq: exit.rounds_eq ?? null,
      satisfied,
    };
    if (satisfied) stop_reason = "condition_met";
  } else if (kind === "polling") {
    const poll = group.poll!;
    const key = poll.evidence_key ?? null;
    const s = key ? evidenceState(cwd, evidenceDir, key) : { state: "missing" as const, satisfied: false };
    // Wall-clock budget runs from the loop's first journaled round so the
    // timeout survives restarts — never from orchestrator prose.
    const firstAt = journal.length > 0 ? Date.parse(journal[0].at) : Date.parse(now);
    const elapsed_ms = Math.max(0, Date.parse(now) - firstAt);
    check = {
      predicate: "poll",
      evidence_key: key,
      state: s.state,
      satisfied: s.satisfied,
      elapsed_ms,
      interval_ms: poll.interval_ms,
      max_wait_ms: poll.max_wait_ms,
    };
    if (s.satisfied) stop_reason = "condition_met";
  }

  if (stop_reason === null) {
    if (no_progress_exhausted) {
      stop_reason = "no_progress";
    } else if (kind === "polling") {
      const bound =
        (check!.elapsed_ms as number) >= (check!.max_wait_ms as number)
          ? "max_wait_ms"
          : round >= group.max_rounds
            ? "max_rounds"
            : null;
      if (bound) {
        check!.bound = bound;
        stop_reason = "poll_timeout";
      }
    } else if (round >= group.max_rounds) {
      stop_reason = "max_rounds";
    }
  }
  const no_progress_via = stop_reason === "no_progress" ? matchedBy : null;

  mkdirSync(roundsDir(cwd, id), { recursive: true });
  const line: JournalLine = {
    round,
    at: now,
    fingerprint: fp,
    up_to: upTo + window.length,
    signature_similarity,
    similarity_threshold: threshold,
    ...(groupSignature != null ? { signature: groupSignature } : {}),
    kind,
    ...(check ? { check } : {}),
  };
  appendFileSync(join(roundsDir(cwd, id), `${groupIdx}.jsonl`), `${JSON.stringify(line)}\n`);
  const kindTag = kind !== "judged" ? ` · ${kind}` : "";
  const pollTag = kind === "polling" && check ? ` · poll ${check.satisfied === true ? "met" : "waiting"}` : "";
  const boundTag = check?.bound ? ` (${check.bound})` : "";
  appendFileSync(
    join(cwd, ".graphkit", "runs", id, "run.md"),
    `- \`round ${round}\` group ${groupIdx} · fp ${fp.slice(0, 12)}${repeated > 1 ? ` · ×${repeated}` : ""}${kindTag}${pollTag}${
      signature_similarity != null ? ` · sim ${signature_similarity.toFixed(3)}` : ""
    }${stop_reason ? ` · ${stop_reason.toUpperCase()}${boundTag}` : ""}\n`,
  );

  return {
    run: id,
    group: groupIdx,
    node: null,
    nodes: [...group.nodes],
    round,
    fingerprint: fp,
    repeated,
    signature_similarity,
    similarity_threshold: threshold,
    no_progress_limit: limit,
    no_progress_exhausted,
    no_progress_via,
    max_rounds: group.max_rounds,
    kind,
    check,
    stop_reason,
  };
}

export function recordRound(cwd: string, groupIdx: number, now = new Date().toISOString()): RoundResult {
  return recordGroupRound(cwd, groupIdx, resolveGroup(cwd, groupIdx), now);
}

/**
 * `gk run poll <group>` — the deterministic poll verb for `kind: polling`
 * groups. Journals exactly one round per call (the orchestrator sleeps
 * `poll.interval_ms` between calls; `gk run poll` itself never blocks) and
 * reports whether the declared evidence marker satisfied the check. Exits
 * "condition_met" on satisfaction, "poll_timeout" once max_wait_ms or
 * max_rounds exhaust, "no_progress" on the fingerprint breaker. Groups of
 * other kinds are refused — their round semantics live on `gk run round`.
 */
export function recordPoll(cwd: string, groupIdx: number, now = new Date().toISOString()): RoundResult {
  const resolved = resolveGroup(cwd, groupIdx);
  if (resolved.group.kind !== "polling") {
    throw new GraphKitError(
      "LOOP_KIND_MISMATCH",
      `loop group ${groupIdx} has kind "${resolved.group.kind}" — \`gk run poll\` drives kind: polling groups only (use \`gk run round\`)`,
    );
  }
  return recordGroupRound(cwd, groupIdx, resolved, now);
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
    kind: "judged",
    check: null,
    stop_reason,
  };
}
