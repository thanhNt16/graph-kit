import type { CbmClient } from "./client.js";
import type { TraceHop } from "./contract.js";
import { runTemplate } from "./templates.js";

// Deterministic question-kind routing: classify the question, then retrieve
// through the primitive that can actually answer it — search alone cannot see
// call edges or isolated variables.
// ponytail: keyword lexicon, no LLM classifier — measured 19/20 on the frozen
// benchmark categories; escalate to few-shot only if a new question kind appears.

export type QueryKind = "callers" | "dataflow" | "deadcode" | "wheredef" | "deps";

const RULES: [RegExp, QueryKind][] = [
  [/declared but never|never (?:read|used|referenced)|\bdead\b|\bunused\b/, "deadcode"],
  [/\b(?:who|which)\b.*\bcalls?\b|\bcallers?\b/, "callers"],
  [/\bhow\b.*\b(?:does|do|are|is)\b|\btrace\b|\bfrom\b.*\bto\b|data.?flow/, "dataflow"],
  [/\bwhere\b.*\b(?:defined|implemented)\b/, "wheredef"],
];

export function classifyQuestion(q: string): QueryKind {
  const s = q.toLowerCase();
  for (const [re, kind] of RULES) if (re.test(s)) return kind;
  return "deps";
}

// "proj.src.cli.commands.graph.registerGraphCommands" -> ["src/cli/commands/graph.ts", "src/cli/commands.ts"]
// (both candidates — the tail segment may be a function or the file itself, e.g. src.index)
export function deriveFiles(qualifiedName: string): string[] {
  // anchor on ".src." — project prefixes may themselves contain dots
  const i = qualifiedName.indexOf(".src.");
  const tail = i >= 0 ? qualifiedName.slice(i + 1) : qualifiedName.replace(/^[^.]*\./, "");
  if (!tail?.startsWith("src")) return [];
  const segs = tail.split(".");
  const full = `${segs.join("/")}.ts`;
  const parent = segs.length > 1 ? `${segs.slice(0, -1).join("/")}.ts` : full;
  return [...new Set([full, parent])];
}

const STOP = new Set([
  "where",
  "what",
  "who",
  "which",
  "how",
  "does",
  "do",
  "are",
  "is",
  "the",
  "a",
  "an",
  "in",
  "on",
  "at",
  "from",
  "to",
  "for",
  "of",
  "and",
  "or",
  "during",
  "with",
  "that",
  "this",
  "it",
  "their",
  "its",
  "by",
  "elsewhere",
  "never",
  "call",
  "calls",
  "calling",
  "defined",
  "implemented",
  "main",
  "function",
  "module",
  "code",
  "production",
  "source",
  "find",
  "trace",
  "gk",
  "cli",
]);

// identifier-looking tokens (camelCase / snake_case / ALLCAPS) — the strongest BM25 queries
export function symbols(q: string): string[] {
  return q
    .split(/[^A-Za-z0-9_-]+/)
    .filter(
      (w) =>
        w.length > 1 &&
        !STOP.has(w.toLowerCase()) &&
        (/[A-Z]/.test(w.slice(1)) || w.includes("_") || /^[A-Z]{2,}$/.test(w)),
    );
}

// whole-question text is a poor BM25 query; strip function words + de-nominalize
// ("validation" -> "validate", "compilation" -> "compile")
export function contentTokens(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9_ ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => t.replace(/ation$/, "e"))
    .join(" ");
}

interface TrimHit {
  n: string;
  q: string; // qualified_name — snippet-fetch key only; stripped from output
  f: string;
  l: string;
  s: number;
}

// serialized hit: q is derivative (name+file carry the anchors); dropping it
// cut tokens 13062→9270 on the frozen benchmark with wrong-count unchanged
type TrimHitOut = Omit<TrimHit, "q">;

export interface RoutedResult {
  kind: QueryKind;
  question: string;
  search: TrimHitOut[];
  structural?: {
    callers?: { fn: string; file: string; line?: number }[];
    callees?: { fn: string; file: string; line?: number }[];
    isolated?: { name: string; file: string; line: number }[];
    snippets?: { n: string; src: string }[];
  };
}

// Every route always includes search results (regression guard: text-match
// wins must survive routing) plus the structural extras the kind needs.
// MCP client returns {content:[{text}], structuredContent}; unwrap to the tool payload
function unwrap<T>(res: unknown): T {
  const r = res as { structuredContent?: unknown; content?: { text?: string }[] };
  if (r?.structuredContent) return r.structuredContent as T;
  const text = r?.content?.[0]?.text;
  return text ? (JSON.parse(text) as T) : (res as T);
}

// Optional result-shaping knobs threaded from `gk graph ask --limit/--depth`.
// Absent keys keep the measured defaults below — existing call sites and
// benchmarks are unchanged unless the caller explicitly overrides.
export interface RouteOpts {
  /** search_graph result cap (default 8). */
  limit?: number;
  /** trace_path hop depth (default 3). */
  depth?: number;
}

export async function routeAndRetrieve(
  client: CbmClient,
  question: string,
  project?: string,
  opts?: RouteOpts,
): Promise<RoutedResult> {
  const kind = classifyQuestion(question);
  const hit = (r: unknown) =>
    unwrap<{
      results: { name: string; qualified_name: string; file_path: string; label: string; start_line: number }[];
    }>(r).results.map((h) => ({ n: h.name, q: h.qualified_name, f: h.file_path, l: h.label, s: h.start_line }));
  const run = (query: string) =>
    client
      .call("search_graph", { query, project, limit: opts?.limit ?? 8 })
      .then(hit)
      .catch(() => [] as TrimHit[]);
  // identifier query first (exact symbol match), token query as fallback/merge
  const symQ = symbols(question).join(" ");
  const [symHits, tokHits] = await Promise.all([
    symQ ? run(symQ) : Promise.resolve([] as TrimHit[]),
    run(contentTokens(question)),
  ]);
  const seen = new Set<string>();
  const search: TrimHit[] = [...symHits, ...tokHits].filter((h) => !seen.has(h.n) && seen.add(h.n));

  const out: RoutedResult = { kind, question, search };
  if (search.length === 0) return out;

  const seed = search[0].n; // top BM25 hit seeds the trace

  if (kind === "callers" || kind === "dataflow" || kind === "deps") {
    // deps ("what does X depend on") = outbound callees; callers = inbound; dataflow = both
    const direction = kind === "callers" ? "inbound" : kind === "deps" ? "outbound" : "both";
    const t = await client
      .call("trace_path", { function_name: seed, project, depth: opts?.depth ?? 3, direction })
      .then((r) => unwrap<{ callers?: TraceHop[]; callees?: TraceHop[] }>(r))
      .catch(() => ({ callers: [], callees: [] }) as { callers?: TraceHop[]; callees?: TraceHop[] });
    const hop = (h?: TraceHop[]) =>
      (h ?? []).map((x) => {
        // R5: server-provided anchors win verbatim; otherwise derive from the
        // qualified name. The tail segment names a FILE when it is all-lowercase
        // ("proj.src.cli.commands.graph" → src/cli/commands/graph.ts, not
        // commands.ts; "proj.src.index" → src/index.ts, not src.ts) and a
        // function (camelCase) when it isn't — then the parent path is the file.
        const files = deriveFiles(x.qualified_name);
        const lastSeg = x.qualified_name.split(".").pop() ?? "";
        const file =
          x.file_path ?? (files.length === 0 ? "" : /^[a-z0-9_-]+$/.test(lastSeg) ? files[0] : files[files.length - 1]);
        return {
          fn: x.name,
          file,
          // line only when the server carried it — output stays byte-identical otherwise
          ...(x.start_line !== undefined ? { line: x.start_line } : {}),
        };
      });
    out.structural = { callers: hop(t.callers), callees: hop(t.callees) };
  }

  if (kind === "deadcode") {
    // dead-code anti-join lives in templates.ts (single source of truth, shared
    // with `gk graph query --template dead-code`); cap stays at the measured 25.
    out.structural = (await runTemplate(client, "dead-code", undefined, project, 25)) as NonNullable<
      RoutedResult["structural"]
    >;
  }

  // source bodies of top seeds: answers live inside function bodies (constants,
  // config keys, formulas) that no graph edge carries
  if (kind !== "deadcode" && kind !== "callers") {
    // file nodes outrank symbols in BM25; snippet only real code nodes
    const codeHits =
      search.filter((h) => ["Function", "Method", "Class", "Variable"].includes(h.l)).slice(0, 3) ?? search.slice(0, 3);
    const snips = await Promise.all(
      (codeHits as TrimHit[])
        .filter((h) => h.q)
        .map((h) =>
          client
            .call("get_code_snippet", { qualified_name: h.q, project })
            .then((r) => unwrap<{ name: string; source: string }>(r))
            .catch(() => undefined),
        ),
    );
    const snippets = snips
      .filter((s): s is { name: string; source: string } => Boolean(s?.source))
      .map((s) => ({ n: s.name, src: s.source.slice(0, 500) }));
    if (snippets.length) out.structural = { ...out.structural, snippets };
  }

  return { ...out, search: search.map(({ q: _q, ...rest }) => rest) };
}
