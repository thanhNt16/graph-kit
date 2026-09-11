const DAY_MS = 86_400_000;

/**
 * Age in days, or null when either timestamp is unparseable ("unknown age").
 * Null is the honest answer: Infinity used to drive recencyDecay to 0 and
 * actRScore to 0, so one loosely-written last_used_at ("recently",
 * "2026-1-5") silently expired an otherwise-healthy memory on the next trace
 * pass — irreversible data loss from a typo. Callers decide the unknown-age
 * policy; traceMemory skips auto-expiry for it.
 */
export function ageDays(lastUsedAt: string, now: string): number | null {
  const t = Date.parse(lastUsedAt);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return null;
  return Math.max(0, (n - t) / DAY_MS);
}

// half-life ~14 days
const HALF_LIFE_DAYS = 14;

/** 0..1 recency weight, or null when the age is unknown. */
export function recencyDecay(lastUsedAt: string, now: string): number | null {
  const age = ageDays(lastUsedAt, now);
  return age === null ? null : 0.5 ** (age / HALF_LIFE_DAYS);
}

export interface ActRInput {
  relevance: number; // 0..1 — to the current objective
  connectivity: number; // 0..1 — normalized graph degree
  use_count: number;
  last_used_at: string; // ISO-8601
  now: string; // ISO-8601
}

/**
 * ACT-R-style activation score in [0,1], or null when the score is UNKNOWN —
 * an unparseable last_used_at (no recency signal) or a non-finite relevance /
 * connectivity / use_count (NaN would otherwise poison the clamp and flow
 * into shouldExpire as a falsy comparison). A null score must never be
 * interpreted as a low score: unknown ≠ expiring.
 */
export function actRScore(i: ActRInput): number | null {
  const decay = recencyDecay(i.last_used_at, i.now);
  if (decay === null) return null;
  if (!Number.isFinite(i.relevance) || !Number.isFinite(i.connectivity) || !Number.isFinite(i.use_count)) return null;
  const reactivation = (1 + Math.log10(1 + i.use_count)) * decay;
  const raw = i.relevance * i.connectivity * (reactivation / 2);
  return Math.max(0, Math.min(1, raw));
}

export function shouldExpire(score: number, threshold = 0.3): boolean {
  return score < threshold;
}
