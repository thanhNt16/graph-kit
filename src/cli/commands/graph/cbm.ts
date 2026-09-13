// CBM subcommand layer for `gk graph`: the action dispatch table, flag
// normalization, and query-template runners. Output contract: MISSING_ARG
// before flag validation, --limit checked before --depth (ask's documented
// order), absent flags omitted from payloads so server-side defaults stay
// authoritative.
import { CBM_UNAVAILABLE_MSG, type CbmClient, isCbmUnavailable } from "../../../cbm/client.js";
import type { QueryResult, SearchResult, TraceResult } from "../../../cbm/contract.js";
import { routeAndRetrieve } from "../../../cbm/route.js";
import { withCbmClient } from "../../../cbm/seam.js";
import { listTemplates, QUERY_TEMPLATES, runTemplate } from "../../../cbm/templates.js";
import { fail, ok, printFail } from "../../output.js";

// Normalize a numeric CLI flag for the CBM primitives: absent (undefined/null/
// "") stays undefined so the server-side default remains authoritative, while a
// provided value must be a positive integer — 0, negatives, and NaN would
// otherwise silently truncate or error deep inside CBM. Null means invalid and
// the caller rejects it with the standard fail envelope at the CLI boundary.
export function parsePositiveInt(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Prepend the F3 contract when the rejection isn't already carrying it, so gk
// always exits with the honest CBM_CMD/CBM_ARGS guidance — never a bare errno.
export function cbmFailure(e: unknown): ReturnType<typeof fail> {
  const msg = String((e as Error)?.message ?? e);
  return fail("CBM_UNAVAILABLE", isCbmUnavailable(e) ? msg : `${CBM_UNAVAILABLE_MSG}\n${msg}`);
}

// printFail adapter over cbmFailure — keeps the mapped code/details contract
// while honoring the human/json split (the CBM catch used to print raw JSON).
export function printCbmFailure(e: unknown, json: boolean): void {
  const f = cbmFailure(e);
  printFail(f.error.code, f.error.message, { details: f.error.details, json });
}

interface CbmFlags {
  limit?: number;
  depth?: number;
}
interface CbmAction {
  missingArg?: { value: (pos: string[]) => string | undefined; message: string };
  usesLimit?: boolean;
  usesDepth?: boolean;
  run: (c: CbmClient, pos: string[], flags: CbmFlags) => Promise<unknown>;
}
const CBM_ACTIONS: Record<string, CbmAction> = {
  search: {
    missingArg: { value: (pos) => pos[0], message: "search requires a pattern argument" },
    usesLimit: true,
    run: (c, pos, flags) =>
      c.call<SearchResult>("search_graph", {
        pattern: pos[0],
        project: pos[1],
        // flag absent → key omitted, so the CBM server-side default stays authoritative
        ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
      }),
  },
  ask: {
    missingArg: {
      value: (pos) => (pos.length > 0 ? pos.join(" ") : undefined),
      message: "ask requires a natural-language question",
    },
    usesLimit: true,
    usesDepth: true,
    // project undefined = CBM derives from cwd, same as `graph search`
    run: (c, pos, flags) => routeAndRetrieve(c, pos.join(" "), undefined, { limit: flags.limit, depth: flags.depth }),
  },
  trace: {
    missingArg: { value: (pos) => pos[0], message: "trace requires a function_name argument" },
    usesDepth: true,
    run: (c, pos, flags) =>
      c.call<TraceResult>("trace_path", {
        function_name: pos[0],
        project: pos[1],
        depth: flags.depth ?? 3,
        direction: "both",
      }),
  },
  query: {
    missingArg: { value: (pos) => pos[0], message: "query requires a Cypher query argument" },
    run: (c, pos) => c.call<QueryResult>("query_graph", { query: pos[0], project: pos[1] }),
  },
};

// R7: one runner for the four CBM primitives.
export async function runCbmAction(
  name: string,
  pos: string[],
  opts: { limit?: number | string; depth?: number | string; json?: boolean },
): Promise<void> {
  const json = opts.json === true;
  try {
    const action = CBM_ACTIONS[name];
    const arg = action.missingArg?.value(pos);
    if (action.missingArg && !arg) {
      printFail("MISSING_ARG", action.missingArg.message, { json });
      return;
    }
    const flags: CbmFlags = {};
    if (action.usesLimit) {
      const limit = parsePositiveInt(opts.limit);
      if (limit === null) {
        printFail("INVALID_LIMIT", `--limit must be a positive integer, got ${JSON.stringify(opts.limit)}`, { json });
        return;
      }
      flags.limit = limit;
    }
    if (action.usesDepth) {
      const depth = parsePositiveInt(opts.depth);
      if (depth === null) {
        printFail("INVALID_DEPTH", `--depth must be a positive integer, got ${JSON.stringify(opts.depth)}`, { json });
        return;
      }
      flags.depth = depth;
    }
    const raw = await withCbmClient((c) => action.run(c, pos, flags));
    console.log(JSON.stringify(ok(raw)));
  } catch (e) {
    printCbmFailure(e, json);
  }
}

// R6: `gk graph query --template <name>` — named template runners with the same
// lifecycle hygiene as the raw actions (withCbmClient close-on-throw).
export async function runQueryTemplate(
  name: string,
  pos: string[],
  opts: { limit?: number | string; json?: boolean },
): Promise<void> {
  const json = opts.json === true;
  const tpl = QUERY_TEMPLATES[name];
  if (!tpl) {
    // no CBM call, no client — the template table is checked offline
    printFail("UNKNOWN_TEMPLATE", `Unknown query template "${name}"`, {
      details: { available: Object.keys(QUERY_TEMPLATES) },
      json,
    });
    return;
  }
  const arg = tpl.argHint ? pos[0] : undefined;
  const project = tpl.argHint ? pos[1] : pos[0];
  if (tpl.argHint && !arg) {
    printFail("MISSING_ARG", `template "${name}" requires an argument (${tpl.argHint})`, { json });
    return;
  }
  const limit = parsePositiveInt(opts.limit);
  if (limit === null) {
    printFail("INVALID_LIMIT", `--limit must be a positive integer, got ${JSON.stringify(opts.limit)}`, { json });
    return;
  }
  try {
    const raw = await withCbmClient((c) => runTemplate(c, name, arg, project, limit ?? 25));
    console.log(JSON.stringify(ok(raw)));
  } catch (e) {
    printCbmFailure(e, json);
  }
}

// R6: `gk graph query --templates` — offline listing, never creates a client.
export function printQueryTemplates(json: boolean | undefined): void {
  const templates = listTemplates();
  if (json) {
    console.log(JSON.stringify(ok({ templates })));
    return;
  }
  const nameW = Math.max("name".length, ...templates.map((t) => t.name.length));
  console.log(`${"name".padEnd(nameW)}  arg  description`);
  for (const t of templates) {
    console.log(`${t.name.padEnd(nameW)}  ${t.arg_hint ?? "-"}  ${t.description}`);
  }
}
