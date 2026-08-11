export type Verdict = "MERGE" | "BLOCK";

export interface WorkProductInput {
  required_keys: string[];
}
export interface EvidenceMap {
  [key: string]: string | undefined;
}

export function scoreWorkProduct(
  input: WorkProductInput,
  evidence: EvidenceMap,
  rubric: "strict" | "lenient" = "strict",
): { verdict: Verdict; scorecard: Record<string, "ok" | "missing" | "empty"> } {
  const scorecard: Record<string, "ok" | "missing" | "empty"> = {};
  let clean = true;
  for (const key of input.required_keys) {
    const val = evidence[key];
    if (val === undefined) {
      scorecard[key] = "missing";
      clean = false;
    } else if (val.trim() === "") {
      scorecard[key] = "empty";
      // lenient tolerates empty; strict does not
      if (rubric === "strict") clean = false;
    } else {
      scorecard[key] = "ok";
    }
  }
  return { verdict: clean ? "MERGE" : "BLOCK", scorecard };
}

export interface MemoryState {
  adherence: number; // 0..1 — did actions respect recalled constraints
  retrieval: number; // 0..1 — were relevant memories actually fetched
  generalization: number; // 0..1 — did distilled experience transfer
  hygiene: number; // 0..1 — no stale/contradictory/duplicate
  staleAnsweredFrom: number; // count: confidently answered from stale memory
  admittedIgnorance: number; // count: correctly said "I don't have that"
}

export function scoreMemory(
  s: MemoryState,
  opts: { abstention_weighted: boolean },
): { adherence: number; retrieval: number; generalization: number; hygiene: number; overall: number } {
  // Abstention weighting: confidently answering from stale memory is worse than admitting ignorance.
  const penalty = opts.abstention_weighted ? 0.1 * s.staleAnsweredFrom : 0;
  const bonus = opts.abstention_weighted ? 0.05 * Math.min(s.admittedIgnorance, 4) : 0;
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const adherence = clamp(s.adherence - penalty + bonus);
  const overall = clamp((adherence + s.retrieval + s.generalization + s.hygiene) / 4);
  return {
    adherence,
    retrieval: s.retrieval,
    generalization: s.generalization,
    hygiene: s.hygiene,
    overall,
  };
}
