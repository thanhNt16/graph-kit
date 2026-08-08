const DAY_MS = 86_400_000;

function ageDays(lastUsedAt: string, now: string): number {
  const t = Date.parse(lastUsedAt);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return Infinity;
  return Math.max(0, (n - t) / DAY_MS);
}

function recencyDecay(lastUsedAt: string, now: string): number {
  // half-life ~14 days
  const halfLife = 14;
  return Math.pow(0.5, ageDays(lastUsedAt, now) / halfLife);
}

export interface ActRInput {
  relevance: number;      // 0..1 — to the current objective
  connectivity: number;   // 0..1 — normalized graph degree
  use_count: number;
  last_used_at: string;   // ISO-8601
  now: string;            // ISO-8601
}

export function actRScore(i: ActRInput): number {
  const reactivation = (1 + Math.log10(1 + i.use_count)) * recencyDecay(i.last_used_at, i.now);
  const raw = i.relevance * i.connectivity * (reactivation / 2);
  return Math.max(0, Math.min(1, raw));
}

export function shouldExpire(score: number, threshold = 0.3): boolean {
  return score < threshold;
}
