// src/memory/lifecycle.ts
// The adherence lifecycle for learned artifacts (ported from autoharness's
// lifecycle.py): bound the store `gk learn` populates. Adopted items score by
// *uses when offered* — opportunity-relative, so idle time never ages anything
// out. probation → graduation review → capacity-capped eviction → reversible
// archive. Pure: no I/O; the filesystem half lives in lifecycle-store.ts.
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { AdherenceSchema, MemoryLifecycleConfig } from "../schemas/memory.schema.js";

export type Adherence = z.infer<typeof AdherenceSchema>;
export type LifecycleConfig = z.infer<typeof MemoryLifecycleConfig>;

export interface LifecycleMember {
  /** Item identity (frontmatter id, falling back to the file basename). */
  name: string;
  adherence: Adherence;
}

export interface LifecycleVerdict {
  name: string;
  /** archive → move under .archive/; live → stays in the store. */
  action: "archive" | "live";
  /** Why: probation window | human-adopted exempt | zero-use graduation |
   *  capacity eviction | survives review (mature). */
  reason: "probation" | "human" | "graduation" | "capacity" | "mature";
  /** use / (requests since anchor) — the opportunity-relative score. */
  rate: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** One lazy pass over the adopted members.
 *
 *  - probation: `requestCount - anchor < maturity` → live, unevictable, and
 *    excluded from the capacity pool (new items get a fair offer window).
 *  - human-adopted (`adopted_by != "gk-learn"`): tracked, never evicted.
 *  - graduation review: mature && use === 0 && view === 0 → archive — unless
 *    `graduation_suspended`, which parks the whole review.
 *  - capacity: surviving mature pool > `capacity` → evict the lowest
 *    (rate, sha256(name)) members until the pool fits.
 */
export function evaluate(members: LifecycleMember[], requestCount: number, cfg: LifecycleConfig): LifecycleVerdict[] {
  const verdicts = new Map<string, LifecycleVerdict>();
  const mature: { name: string; rate: number }[] = [];

  for (const m of members) {
    const a = m.adherence;
    const denom = Math.max(0, requestCount - a.anchor);
    const rate = denom > 0 ? a.use / denom : 0;
    if (a.adopted_by !== "gk-learn") {
      verdicts.set(m.name, { name: m.name, action: "live", reason: "human", rate });
      continue;
    }
    if (denom < cfg.maturity) {
      verdicts.set(m.name, { name: m.name, action: "live", reason: "probation", rate });
      continue;
    }
    if (!cfg.graduation_suspended && a.use === 0 && a.view === 0) {
      verdicts.set(m.name, { name: m.name, action: "archive", reason: "graduation", rate });
      continue;
    }
    mature.push({ name: m.name, rate });
    verdicts.set(m.name, { name: m.name, action: "live", reason: "mature", rate });
  }

  if (mature.length > cfg.capacity) {
    const ranked = [...mature].sort((x, y) => x.rate - y.rate || sha256(x.name).localeCompare(sha256(y.name)));
    for (const evicted of ranked.slice(0, mature.length - cfg.capacity)) {
      const v = verdicts.get(evicted.name);
      if (v) {
        v.action = "archive";
        v.reason = "capacity";
      }
    }
  }

  return members.map((m) => {
    const v = verdicts.get(m.name);
    if (!v) throw new Error(`evaluate: no verdict for ${m.name}`);
    return v;
  });
}
