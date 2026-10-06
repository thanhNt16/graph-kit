import type { z } from "zod";
import { GraphKitError } from "../errors.js";

/** One diagnostic, wherever it came from: a schema parse (zod) or a semantic
 *  check (validateGraph). SCHEMA_INVALID and VALIDATION_FAILED both carry
 *  `details.issues: Issue[]`; semantic entries keep `check`/`severity` as
 *  extra fields rather than a second envelope. */
export interface Issue {
  path: string;
  message: string;
  hint?: string;
}

/** THE zod→issue formatter: every SCHEMA_INVALID details.issues flows through here.
 *  Pass the parsed schema when one exists so unrecognized_keys get a candidate list. */
export function formatZodIssues(e: z.ZodError, schema?: z.core.$ZodType): Issue[] {
  return e.issues.map((i) => {
    const issue: Issue = { path: i.path.join("."), message: i.message };
    const hint = keyHint(i, schema);
    if (hint) issue.hint = hint;
    return issue;
  });
}

/** Did-you-mean for unrecognized_keys: zod v4 carries the UNRECOGNIZED keys on
 *  the issue, so the expected-key candidates come from the schema at the issue
 *  path (record/array/object descent). No schema -> no hint. */
function keyHint(i: z.core.$ZodIssue, schema?: z.core.$ZodType): string | undefined {
  if (i.code !== "unrecognized_keys" || !schema) return undefined;
  const target = schemaAt(schema, i.path);
  const shape = (target as { shape?: Record<string, z.core.$ZodType> } | undefined)?.shape;
  if (!shape) return undefined;
  for (const typo of i.keys.map(String)) {
    const [best] = closeMatches(typo, Object.keys(shape));
    if (best && best !== typo) return `did you mean "${best}"?`;
  }
  return undefined;
}

/** Descend a schema along a zod issue path: object shape lookup, records keep
 *  their valueType across a dynamic key segment, arrays step into element. */
function schemaAt(schema: z.core.$ZodType, path: PropertyKey[]): z.core.$ZodType | undefined {
  let cur: z.core.$ZodType | undefined = schema;
  for (const seg of path) {
    if (!cur) return undefined;
    // Unwrap zod v4 wrapper schemas (default/optional/nullable/readonly) whose
    // payload lives in def.innerType.
    for (let d = cur as { def?: { innerType?: z.core.$ZodType } }; d.def?.innerType; d = cur as typeof d) {
      cur = d.def.innerType;
    }
    if (!cur) return undefined;
    const s = cur as {
      shape?: Record<string, z.core.$ZodType>;
      valueType?: z.core.$ZodType;
      element?: z.core.$ZodType;
    };
    if (s.shape) cur = s.shape[String(seg)];
    else if (s.valueType)
      cur = s.valueType; // record key segment: step into the value schema
    else if (s.element) cur = s.element;
    else return undefined;
  }
  return cur;
}

/** Levenshtein-ish close-match scoring for unknown-name suggestions. */
export function closeMatches(name: string, available: string[]): string[] {
  const scored = available
    .map((candidate) => ({ candidate, score: levenshtein(name, candidate) }))
    .sort((a, b) => a.score - b.score);
  return scored
    .slice(0, 3)
    .filter((s) => s.score <= 3)
    .map((s) => s.candidate);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

/** The catch-site contract: coded throws pass through untouched (code, message,
 *  details intact); anything else is wrapped in the fallback code so the
 *  envelope never leaks an uncoded error. */
export function toGraphKitError(e: unknown, fallback: string): GraphKitError {
  if (e instanceof GraphKitError) return e;
  return new GraphKitError(fallback, String((e as Error)?.message ?? e));
}
