import { GraphKitError } from "../errors.js";
import type { MergeDeclaration, MergePolicy } from "../schemas.js";

function conflict(message: string): GraphKitError {
  return new GraphKitError("ERR_MERGE_CONFLICT", message);
}

function compareForPolicy(a: unknown, b: unknown, policy: "maximum" | "minimum"): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  throw conflict(`${policy} requires numeric values`);
}

function applyAppendUnique(declaration: MergeDeclaration, previous: unknown[], incoming: unknown[]): unknown[] {
  const identity = declaration.identity;
  if (!identity) return previous.concat(incoming);
  const seen = new Set<unknown>();
  for (const item of previous) seen.add(readIdentity(item, identity));
  const out = previous.slice();
  for (const item of incoming) {
    const key = readIdentity(item, identity);
    if (seen.has(key)) continue; // keep first accepted identity
    seen.add(key);
    out.push(item);
  }
  return out;
}

function readIdentity(item: unknown, identity: string): unknown {
  if (item !== null && typeof item === "object") {
    return (item as Record<string, unknown>)[identity];
  }
  return undefined;
}

export function mergeStateField(
  declaration: MergeDeclaration | undefined,
  previous: unknown,
  incoming: unknown,
): unknown {
  if (!declaration) {
    throw new GraphKitError("ERR_UNDECLARED_MERGE", "no merge policy declared for state field");
  }
  const policy: MergePolicy = declaration.merge;
  switch (policy) {
    case "replace":
      return incoming;
    case "append":
      return (Array.isArray(previous) ? previous : []).concat(Array.isArray(incoming) ? incoming : []);
    case "append_unique":
      return applyAppendUnique(
        declaration,
        Array.isArray(previous) ? previous : [],
        Array.isArray(incoming) ? incoming : [],
      );
    case "first":
      return previous === undefined ? incoming : previous;
    case "maximum":
      return compareForPolicy(previous, incoming, "maximum") >= 0 ? previous : incoming;
    case "minimum":
      return compareForPolicy(previous, incoming, "minimum") <= 0 ? previous : incoming;
    case "merge_object": {
      if (typeof previous !== "object" || typeof incoming !== "object" || previous === null || incoming === null) {
        throw conflict("merge_object requires object values");
      }
      return { ...(previous as Record<string, unknown>), ...(incoming as Record<string, unknown>) };
    }
    case "reject_conflict":
      if (JSON.stringify(previous) !== JSON.stringify(incoming)) throw conflict("conflicting values");
      return previous;
  }
}
