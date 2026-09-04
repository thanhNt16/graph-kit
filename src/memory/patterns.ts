// src/memory/patterns.ts
// Deterministic pattern extraction over the run ledger. Zero model calls:
// everything here is counting, and counting is free.
import { createHash } from "node:crypto";
import type { AdvisorEvent, RunIndexLine, TraceLine } from "./ledger.js";

export type PatternKind =
  | "node-sequence"
  | "evidence-cooccurrence"
  | "failure-recurrence"
  | "graph-reuse"
  | "advisor-repeat";

export interface Pattern {
  signature: string;
  kind: PatternKind;
  label: string;
  members: string[];
  runs: string[];
  count: number;
  last_seen: string;
  salience: number;
}

const SEQ_MIN_RUNS = 3;
const SEQ_MIN_LEN = 2;
const SEQ_MAX_LEN = 4;
const COOCCUR_MIN_RUNS = 3;
const FAILURE_MIN = 2;
const REUSE_MIN_RUNS = 3;
const ADVISOR_MIN = 2;
const HALF_LIFE_DAYS = 14; // same constant as src/eval/forgetting.ts
const DAY_MS = 86_400_000;

/** count × exp2 recency decay. Frequent-but-stale ranks below frequent-and-recent. */
export function patternSalience(count: number, lastSeen: string, now: string): number {
  const t = Date.parse(lastSeen);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return count;
  const ageDays = Math.max(0, (n - t) / DAY_MS);
  return count * 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

function signatureOf(kind: PatternKind, members: string[]): string {
  return createHash("sha1")
    .update(`${kind}::${members.join("\u0000")}`)
    .digest("hex")
    .slice(0, 8);
}

/** Accumulator: which runs contributed, how many hits, and the newest timestamp. */
interface Acc {
  runs: Set<string>;
  count: number;
  last: string;
}

function bump(map: Map<string, Acc>, key: string, runId: string, at: string) {
  const cur = map.get(key) ?? { runs: new Set<string>(), count: 0, last: at };
  cur.runs.add(runId);
  cur.count += 1;
  if (at > cur.last) cur.last = at;
  map.set(key, cur);
}

function toPattern(kind: PatternKind, members: string[], label: string, acc: Acc, now: string): Pattern {
  return {
    signature: signatureOf(kind, members),
    kind,
    label,
    members,
    runs: Array.from(acc.runs).sort(),
    count: acc.count,
    last_seen: acc.last,
    salience: patternSalience(acc.count, acc.last, now),
  };
}

export function extractPatterns(
  runs: RunIndexLine[],
  traces: Map<string, TraceLine[]>,
  advisors: Map<string, AdvisorEvent[]> = new Map(),
  now = new Date().toISOString(),
): Pattern[] {
  const sequences = new Map<string, Acc>();
  const cooccur = new Map<string, Acc>();
  const failures = new Map<string, Acc>();
  const advisorAcc = new Map<string, Acc>();
  const reuse = new Map<string, Acc>();

  for (const run of runs) {
    const trace = traces.get(run.id) ?? [];
    const at = run.ended_at || run.started_at;

    // node-sequence: contiguous n-grams of node ids, length 2..4
    const ids = trace.map((t) => t.node);
    for (let len = SEQ_MIN_LEN; len <= SEQ_MAX_LEN; len += 1) {
      for (let i = 0; i + len <= ids.length; i += 1) {
        bump(sequences, ids.slice(i, i + len).join("\u0000"), run.id, at);
      }
    }

    // evidence-cooccurrence: unordered pairs of keys produced in the same run
    const keys = Array.from(new Set(trace.flatMap((t) => t.evidence).concat(run.evidence_keys))).sort();
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        bump(cooccur, `${keys[i]}\u0000${keys[j]}`, run.id, at);
      }
    }

    // failure-recurrence: a node id that failed
    for (const t of trace) if (t.status === "fail") bump(failures, t.node, run.id, t.at || at);

    // advisor-repeat: a node consumed advisor help
    for (const ev of advisors.get(run.id) ?? []) bump(advisorAcc, ev.node, run.id, ev.at || at);

    // graph-reuse: identical graph content run repeatedly
    bump(reuse, `${run.graph}\u0000${run.graph_sha256}`, run.id, at);
  }

  const out: Pattern[] = [];
  for (const [key, acc] of sequences) {
    if (acc.runs.size < SEQ_MIN_RUNS) continue;
    const members = key.split("\u0000");
    out.push(toPattern("node-sequence", members, members.join(" → "), acc, now));
  }
  for (const [key, acc] of cooccur) {
    if (acc.runs.size < COOCCUR_MIN_RUNS) continue;
    const members = key.split("\u0000");
    out.push(toPattern("evidence-cooccurrence", members, members.join(" + "), acc, now));
  }
  for (const [key, acc] of failures) {
    if (acc.runs.size < FAILURE_MIN) continue;
    out.push(toPattern("failure-recurrence", [key], key, acc, now));
  }
  for (const [key, acc] of advisorAcc) {
    if (acc.runs.size < ADVISOR_MIN) continue;
    out.push(toPattern("advisor-repeat", [key], `${key} needed advisor help`, acc, now));
  }
  for (const [key, acc] of reuse) {
    if (acc.runs.size < REUSE_MIN_RUNS) continue;
    const members = key.split("\u0000");
    out.push(toPattern("graph-reuse", members, members[0], acc, now));
  }
  return out.sort((a, b) => b.salience - a.salience || a.signature.localeCompare(b.signature));
}
