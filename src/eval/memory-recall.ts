// Pure recall filters — the reference implementation of gk-recall steps 4-5
// (temporal validity + supersede resolution). Unit-tested; the eval runner and
// the skill both apply exactly these rules.

export interface RecallEntry {
  id: string;
  file: string;
  /** parsed frontmatter fields the filters need */
  valid_from?: string;
  valid_to?: string;
  expired?: boolean;
  superseded_by?: string;
}

/** Drop expired, not-yet-valid, past-valid entries (gk-recall step 4). */
export function dropInvalid(entries: RecallEntry[], now: string): RecallEntry[] {
  const t = Date.parse(now);
  return entries.filter((e) => {
    if (e.expired === true) return false;
    if (e.valid_from && Date.parse(e.valid_from) > t) return false;
    if (e.valid_to && Date.parse(e.valid_to) < t) return false;
    return true;
  });
}

/** Resolve supersede chains: replace a superseded head with its current version
 *  if present, else drop it (gk-recall step 5 — surface only the newest member). */
export function resolveSuperseded(entries: RecallEntry[]): RecallEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out: RecallEntry[] = [];
  for (const e of entries) {
    if (!e.superseded_by) {
      if (!out.some((o) => o.id === e.id)) out.push(e);
      continue;
    }
    // follow the chain to its current, present member
    let cur = e.superseded_by;
    const seen = new Set([e.id]);
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const next = byId.get(cur);
      if (!next) break;
      if (!next.superseded_by) break;
      cur = next.superseded_by;
    }
    const successor = cur && byId.has(cur) ? byId.get(cur) : undefined;
    if (successor && !successor.superseded_by && !out.includes(successor)) out.push(successor);
  }
  return out;
}

/** Full recall filter pipeline (validity, then supersede). */
export function applyRecallFilters(entries: RecallEntry[], now: string): RecallEntry[] {
  return resolveSuperseded(dropInvalid(entries, now));
}
