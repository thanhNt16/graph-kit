import { GraphKitError } from "../errors.js";
import { isCbmUnavailable, type CbmClient } from "./client.js";

// Named query templates over the CBM graph — runners, not raw Cypher strings.
// The CBM dialect is unverifiable while the npm package 404s, so only proven
// constructs ship ((n:Label) MATCH, (n)-[r]->(m), DISTINCT, ORDER BY, LIMIT);
// every other filter is applied client-side TS.

export interface QueryTemplate {
  description: string;
  /** Present = the template takes one positional argument (e.g. a symbol or file path). */
  argHint?: string;
  run(client: CbmClient, arg: string | undefined, project: string | undefined, limit: number): Promise<unknown>;
}

// MCP client returns {content:[{text}], structuredContent}; unwrap to the tool payload
// (same shape-unwrapping contract as route.ts).
function unwrap<T>(res: unknown): T {
  const r = res as { structuredContent?: unknown; content?: { text?: string }[] };
  if (r?.structuredContent) return r.structuredContent as T;
  const text = r?.content?.[0]?.text;
  return text ? (JSON.parse(text) as T) : (res as T);
}

const QUERY_GRAPH = "query_graph";

// Per-query rejections fail open (same semantics as route.ts); a dead bridge
// rethrows — "isolated: []" from a corpse client reads as a real answer.
function failOpen<T>(fallback: T): (e: unknown) => T {
  return (e: unknown) => {
    if (isCbmUnavailable(e)) throw e;
    return fallback;
  };
}

export const QUERY_TEMPLATES: Record<string, QueryTemplate> = {
  "dead-code": {
    description: "Variables declared but never referenced by any edge (isolated declarations)",
    run: async (client, _arg, project, limit) => {
      // CBM Cypher has no NOT (n)--() anti-pattern; anti-join client-side:
      // all Variables minus Variables with outgoing edges = isolated declarations.
      const all = await client
        .call(QUERY_GRAPH, {
          query: "MATCH (n:Variable) RETURN n.name, n.file_path, n.start_line ORDER BY n.file_path LIMIT 500",
          project,
        })
        .then((r) => unwrap<{ rows: unknown[][] }>(r))
        .catch(failOpen({ rows: [] as unknown[][] }));
      const withEdges = await client
        .call(QUERY_GRAPH, {
          query: "MATCH (n:Variable)-[r]->(m) RETURN DISTINCT n.name",
          project,
        })
        .then((r) => unwrap<{ rows: unknown[][] }>(r))
        .catch(failOpen({ rows: [] as unknown[][] }));
      const linked = new Set(withEdges.rows.map((r) => String(r[0])));
      const cap = Number.isInteger(limit) && limit > 0 ? limit : 25;
      return {
        isolated: all.rows
          .filter((r) => !linked.has(String(r[0])) && /\.(ts|js|cjs|mjs)$/.test(String(r[1])))
          // even alphanumeric sort — src-first bias buried scripts/ vars (_GK_BIN
          // at idx 73); even sort keeps them reachable at slice 25 (idx 23)
          .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
          .slice(0, cap)
          .map((r) => ({ name: String(r[0]), file: String(r[1]), line: Number(r[2]) })),
      };
    },
  },
  "callers-of": {
    description: "Direct callers of a symbol",
    argHint: "<symbol>",
    run: async (client, arg, project) => {
      // One broad inbound-edge scan, capped server-side; the exact symbol match
      // is applied client-side (the dialect has no verifiable parameter syntax).
      const res = await client
        .call(QUERY_GRAPH, {
          query:
            "MATCH (m)-[r]->(n) RETURN DISTINCT m.name, m.file_path, n.name, n.start_line ORDER BY m.file_path LIMIT 500",
          project,
        })
        .then((r) => unwrap<{ rows: unknown[][] }>(r))
        .catch(failOpen({ rows: [] as unknown[][] }));
      const callers = res.rows
        .filter((r) => String(r[2]) === arg)
        .map((r) => ({ name: String(r[0]), file: String(r[1]), line: Number(r[3]) }));
      return { symbol: arg, callers };
    },
  },
  "symbol-set": {
    description: "Symbols declared in a file vs the files that reference them",
    argHint: "<file-path>",
    run: async (client, arg, project) => {
      // One wide scan over all nodes; partitioned client-side by file_path.
      const res = await client
        .call(QUERY_GRAPH, {
          query: "MATCH (n) RETURN n.name, n.file_path, n.label, n.start_line ORDER BY n.file_path LIMIT 2000",
          project,
        })
        .then((r) => unwrap<{ rows: unknown[][] }>(r))
        .catch(failOpen({ rows: [] as unknown[][] }));
      const toSym = (r: unknown[]) => ({ name: String(r[0]), file: String(r[1]), line: Number(r[3]) });
      const declaredRows = res.rows.filter((r) => String(r[1]) === arg);
      const declaredNames = new Set(declaredRows.map((r) => String(r[0])));
      const referencingFiles = new Set<string>();
      const referenced = new Set<string>();
      for (const r of res.rows) {
        if (String(r[1]) === arg) continue;
        const name = String(r[0]);
        if (declaredNames.has(name)) {
          referencingFiles.add(String(r[1]));
          referenced.add(name);
        }
      }
      return {
        file: arg,
        declared: declaredRows.map(toSym),
        referencing_files: [...referencingFiles].sort(),
        unreferenced: declaredRows.filter((r) => !referenced.has(String(r[0]))).map(toSym),
      };
    },
  },
};

/** Run a named template; throws GraphKitError("UNKNOWN_TEMPLATE") for unknown names. */
export async function runTemplate(
  client: CbmClient,
  name: string,
  arg: string | undefined,
  project: string | undefined,
  limit: number,
): Promise<unknown> {
  const tpl = QUERY_TEMPLATES[name];
  if (!tpl) {
    throw new GraphKitError("UNKNOWN_TEMPLATE", `Unknown query template "${name}"`, {
      available: Object.keys(QUERY_TEMPLATES),
    });
  }
  return tpl.run(client, arg, project, limit);
}

/** Offline listing for `gk graph query --templates` — no CBM client needed. */
export function listTemplates(): Array<{ name: string; description: string; arg_hint?: string }> {
  return Object.entries(QUERY_TEMPLATES).map(([name, t]) => ({
    name,
    description: t.description,
    ...(t.argHint ? { arg_hint: t.argHint } : {}),
  }));
}
