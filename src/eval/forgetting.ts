const DAY_MS = 86_400_000;

/** ACT-R recency half-life, shared with pattern salience. */
export const HALF_LIFE_DAYS = 14;

function ageDays(lastUsedAt: string, now: string): number {
  const t = Date.parse(lastUsedAt);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return Infinity;
  return Math.max(0, (n - t) / DAY_MS);
}

function recencyDecay(lastUsedAt: string, now: string): number {
  return 0.5 ** (ageDays(lastUsedAt, now) / HALF_LIFE_DAYS);
}

export interface ActRInput {
  relevance: number; // 0..1 — to the current objective
  connectivity: number; // 0..1 — normalized graph degree
  use_count: number;
  last_used_at: string; // ISO-8601
  now: string; // ISO-8601
}

export function actRScore(i: ActRInput): number {
  const reactivation = (1 + Math.log10(1 + i.use_count)) * recencyDecay(i.last_used_at, i.now);
  const raw = i.relevance * i.connectivity * (reactivation / 2);
  return Math.max(0, Math.min(1, raw));
}

/** A memory expires below this ACT-R operating point. The three sub-one
 *  factors of actRScore multiply, so scores rarely clear 0.3 — 0.1 is the
 *  threshold every caller (memory trace) actually uses. */
export function shouldExpire(score: number, threshold = 0.1): boolean {
  return score < threshold;
}
