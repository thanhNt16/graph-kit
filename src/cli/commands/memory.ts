import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { CBM_UNAVAILABLE_MSG, type CbmClient, createCbmClient } from "../../cbm/client.js";
import { indexProject } from "../../cbm/index.js";
import { actRScore, shouldExpire } from "../../eval/forgetting.js";
import { atomicWrite } from "../../fs.js";
import { consolidate } from "../../memory/consolidate.js";
import { parseMemoryFile, walkMemoryStore } from "../../memory/frontmatter.js";
import { type ExpandedHit, expandedRecall } from "../../memory/recall-expanded.js";
import { MemoryConfig } from "../../schemas/memory.schema.js";
import { subcommandsFor } from "../command-registry.js";
import { fail, ok } from "../output.js";

// ponytail: DI seam for tests — avoids spawning the real CBM server.
let _cbmClientFactory: () => CbmClient = () => createCbmClient();
let _indexProjectFn: typeof indexProject = indexProject;
/** @internal test seam — inject client + index implementations. */
export function _setMemoryCbmSeam(opts: { clientFactory?: () => CbmClient; indexProject?: typeof indexProject }) {
  if (opts.clientFactory) _cbmClientFactory = opts.clientFactory;
  if (opts.indexProject) _indexProjectFn = opts.indexProject;
}
/** @internal test seam — restore real implementations. */
export function _resetMemoryCbmSeam() {
  _cbmClientFactory = () => createCbmClient();
  _indexProjectFn = indexProject;
}

// project precedence: --project flag → graph.yaml topology_config.memory.project → default
function resolveProject(cwd: string, override?: string): string {
  if (override) return override;
  try {
    const graph = YAML.parse(readFileSync(join(cwd, "graph.yaml"), "utf-8"));
    const fromCfg = graph?.topology_config?.memory?.project;
    if (typeof fromCfg === "string" && fromCfg) return fromCfg;
  } catch {
    /* no graph.yaml — fall back to default */
  }
  return "graph-kit-memory";
}

export async function indexMemory(cwd: string, projectOverride?: string) {
  const project = resolveProject(cwd, projectOverride);
  const memDir = join(cwd, ".graphkit", "memory");
  mkdirSync(memDir, { recursive: true });

  const client = _cbmClientFactory();
  try {
    await _indexProjectFn(client, { repoPath: memDir, name: project });
  } finally {
    await client.close();
  }

  const watermark = new Date().toISOString();
  // ponytail: .last-index stays CBM-only — it is the freshness watermark the
  // gk-recall skill checks before querying the CBM project populated by indexMemory.
  // Compiled/workflow paths never read or write it.
  writeFileSync(join(cwd, ".graphkit", ".last-index"), watermark);
  return { project, indexed: true, watermark };
}

export interface MemoryTrace {
  id: string;
  score: number;
  state: "live" | "expired" | "superseded";
  action: "kept" | "newly-expired" | "already-expired" | "superseded";
}

export interface MemoryTraceReport {
  total: number;
  live: number;
  expired: number;
  newly_expired: number;
  superseded: number;
  memories: MemoryTrace[];
}

// ponytail: `.last-index` remains CBM-only; file mutations do not create a
// dirty marker. Re-index explicitly when the CBM freshness watermark requires it.

// Stage 5 of the memory pipeline (decay): score every memory with ACT-R and
// mark below-threshold entries expired. Expired files are rewritten in place,
// never deleted (audit rule from the curator contract). Every pass appends
// one JSONL row per memory to .graphkit/.trace-log — decay silently rewriting
// files in place is otherwise unauditable.
export function traceMemory(
  cwd: string,
  now = new Date().toISOString(),
  opts?: { expire_policy?: "act_r" | "manual" },
): MemoryTraceReport {
  const memDir = join(cwd, ".graphkit", "memory");
  const report: MemoryTraceReport = { total: 0, live: 0, expired: 0, newly_expired: 0, superseded: 0, memories: [] };
  // Reserved names are workflows' indexes, not memory entries.
  const files = existsSync(memDir) ? readdirSync(memDir) : [];
  const entries = files.filter((f) => f.endsWith(".md") && f !== "index.md" && f !== "log.md");
  if (!existsSync(memDir) || entries.length === 0) return report;

  const expireActive = opts?.expire_policy !== "manual";

  for (const file of entries) {
    const path = join(memDir, file);
    const raw = readFileSync(path, "utf-8");
    // Strict schema parse before rewrites; malformed entries are counted but
    // skipped. Shared reader (frontmatter.ts): legacy string tags coerced,
    // id/type defaulted — the single coercion rule for the whole store.
    const parsed = parseMemoryFile(raw, file.replace(/\.md$/, ""));
    if (!parsed) continue;
    const fm = parsed.fm as unknown as Record<string, unknown>;
    report.total++;

    if (fm.superseded_by) {
      report.superseded++;
      report.memories.push({ id: String(fm.id ?? file), score: 0, state: "superseded", action: "superseded" });
      continue;
    }

    const tags = Array.isArray(fm.tags) ? fm.tags.length : 0;
    const links = (raw.match(/\[\[[^\]]+\]\]/g) ?? []).length;
    // ponytail: connectivity heuristic — floor 0.5 with no signal, tags+wikilinks
    // normalized at 3 above that; monotonic so adding a tag never lowers a score.
    // Upgrade to real graph degree if memory entries ever get CBM-indexed edges.
    const connectivity = Math.max(0.5, Math.min(1, (tags + links) / 3));
    const score = actRScore({
      relevance: typeof fm.salience === "number" ? fm.salience : 0.5,
      connectivity,
      use_count: typeof fm.use_count === "number" ? fm.use_count : 1,
      last_used_at: String(fm.last_used_at ?? fm.valid_from ?? fm.created_at ?? now),
      now,
    });

    const wasExpired = fm.expired === true;
    // 0.1, not forgetting.ts's 0.3 default: three ≤1 factors multiply, so a
    // neutral memory (salience 0.5 × connectivity 0.5) scores ~0.15 at peak and
    // could never survive a 0.3 gate. `expire_policy: manual` scores and reports
    // only, never mutates the store.
    if (!wasExpired && expireActive && shouldExpire(score, 0.1)) {
      fm.expired = true;
      fm.valid_to = now;
      fm.status = "deprecated";
      // F6: in-place rewrite of a file the user may read — atomic, so a crash
      // mid-decay leaves the previous frontmatter intact.
      atomicWrite(path, `---\n${YAML.stringify(fm)}---\n${parsed.body}`);
      report.expired++;
      report.newly_expired++;
      report.memories.push({ id: String(fm.id ?? file), score, state: "expired", action: "newly-expired" });
    } else if (wasExpired) {
      report.expired++;
      report.memories.push({ id: String(fm.id ?? file), score, state: "expired", action: "already-expired" });
    } else {
      report.live++;
      report.memories.push({ id: String(fm.id ?? file), score, state: "live", action: "kept" });
    }
  }
  appendFileSync(
    join(cwd, ".graphkit", ".trace-log"),
    `${report.memories
      .map((m) => JSON.stringify({ ts: now, id: m.id, action: m.action, score: +m.score.toFixed(4) }))
      .join("\n")}\n`,
  );
  return report;
}

// Reinforcement: recall that surfaces a memory must bump its use_count and
// last_used_at, or ACT-R decay expires the entire store uniformly (~day 10 for
// neutral memories) regardless of recall value. Called by gk-recall survivors
// and standalone `gk memory touch`.
export function touchMemory(
  cwd: string,
  id: string,
  now = new Date().toISOString(),
): { id: string; file: string; use_count: number; last_used_at: string } | null {
  const memDir = join(cwd, ".graphkit", "memory");
  // Root plus one sublevel (patterns/, suggestions/) — subfolder entries must
  // get use_count reinforcement too, or decay eventually evicts every pattern.
  // walkMemoryStore applies the same legacy-tags coercion as traceMemory, so a
  // `tags: "foo"` store entry is reinforced instead of silently dropped.
  for (const entry of walkMemoryStore(memDir)) {
    if (entry.id !== id) continue;
    const fm = entry.fm as unknown as Record<string, unknown>;
    const useCount = (typeof fm.use_count === "number" ? fm.use_count : 1) + 1;
    fm.use_count = useCount;
    fm.last_used_at = now;
    // F6: reinforcement rewrite is atomic — decay reads these files concurrently.
    atomicWrite(entry.path, `---\n${YAML.stringify(entry.fm)}---\n${entry.body}`);
    return { id: entry.id, file: entry.file, use_count: useCount, last_used_at: now };
  }
  return null;
}

// O(k) reinforcement for recall: expandedRecall already knows each hit's
// store-relative path, so read exactly that one file instead of rescanning the
// whole store per hit (k hits ⇒ k reads, not k × store scans).
export function touchMemoryByPath(
  cwd: string,
  relPath: string,
  id: string,
  now = new Date().toISOString(),
): { id: string; file: string; use_count: number; last_used_at: string } | null {
  const path = join(cwd, ".graphkit", "memory", relPath);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null; // vanish mid-recall is a skip, not a failure
  }
  const parsed = parseMemoryFile(raw, basename(relPath).replace(/\.md$/, ""));
  if (!parsed || parsed.fm.id !== id) return null;
  const fm = parsed.fm as unknown as Record<string, unknown>;
  const useCount = (typeof fm.use_count === "number" ? fm.use_count : 1) + 1;
  fm.use_count = useCount;
  fm.last_used_at = now;
  atomicWrite(path, `---\n${YAML.stringify(parsed.fm)}---\n${parsed.body}`);
  return { id: parsed.fm.id, file: relPath, use_count: useCount, last_used_at: now };
}

// ponytail: DI seam for tests — lets the recall suite observe that k hits issue
// exactly k single-file reinforcements. Restore via _resetTouchSeam.
let _touchByPath: typeof touchMemoryByPath = touchMemoryByPath;
/** @internal test seam — inject a counting/wrapping touch implementation. */
export function _setTouchSeam(fn: typeof touchMemoryByPath) {
  _touchByPath = fn;
}
/** @internal test seam — restore the real single-file touch. */
export function _resetTouchSeam() {
  _touchByPath = touchMemoryByPath;
}

// First ~80 chars of a hit's body, whitespace-collapsed, for the human renderer.
function snippet(body: string, max = 80): string {
  const flat = body.trim().replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function recallHitBody(memDir: string, hit: ExpandedHit): string {
  try {
    return parseMemoryFile(readFileSync(join(memDir, hit.path), "utf-8"), hit.id)?.body ?? "";
  } catch {
    return ""; // unreadable hit body degrades to an empty snippet, never a crash
  }
}

// Human default for `gk memory recall`: one short line per hit (id, score,
// salience, body snippet). `--json` prints the machine envelope instead.
export function renderRecallHits(memDir: string, query: string, results: ExpandedHit[], linked: number): string {
  if (results.length === 0) return `no memories matched "${query}"`;
  const width = Math.max(...results.map((r) => r.id.length));
  const lines = results.map(
    (h) =>
      `  ${h.id.padEnd(width)}  score ${h.score.toFixed(2)}  salience ${h.salience.toFixed(2)}${
        h.linked ? "  [linked]" : ""
      }  ${snippet(recallHitBody(memDir, h))}`,
  );
  return [`recall "${query}" — ${results.length} hit(s), ${linked} linked`, ...lines].join("\n");
}

export function registerMemoryCommands(cli: CAC) {
  // cac (6.x) matches a single leading token only; "memory index" never
  // dispatches. Use one `memory` command with subcommand dispatch (like graph).
  cli
    .command("memory [subcommand] [args...]", `Memory commands\nSubcommands: ${subcommandsFor("memory")}`)
    .option("--project <project>", "CBM project name (default: graph.yaml memory.project or graph-kit-memory)")
    .option("--json", "JSON output")
    .action(async (subcommand, _args, opts) => {
      if (!subcommand) {
        // Bare `gk memory` prints usage and exits 0 — a documented surface, not an error.
        console.log(
          `gk memory — memory lifecycle commands\n\nUsage:\n  gk memory <subcommand> [args...]\n
Subcommands: ${subcommandsFor("memory")}\n\nOptions:\n  --project <project>  CBM project name\n  --json               JSON output`,
        );
        return;
      }
      if (subcommand === "consolidate") {
        console.log(JSON.stringify(ok(consolidate(process.cwd()))));
        return;
      }
      if (subcommand === "trace") {
        // decay pass: ACT-R score + expiry marking, no CBM needed
        try {
          console.log(JSON.stringify(ok(traceMemory(process.cwd()))));
        } catch (e) {
          // a corrupt store must exit via the JSON contract, not a raw stack trace
          console.log(
            JSON.stringify(fail("MEMORY_TRACE_FAILED", `trace failed: ${String((e as Error)?.message ?? e)}`)),
          );
          process.exit(1);
          return;
        }
        return;
      }
      if (subcommand === "touch") {
        const id = Array.isArray(_args) ? _args[0] : _args;
        let touched: ReturnType<typeof touchMemory>;
        try {
          touched = id ? touchMemory(process.cwd(), String(id)) : null;
        } catch (e) {
          console.log(
            JSON.stringify(fail("MEMORY_TOUCH_FAILED", `touch failed: ${String((e as Error)?.message ?? e)}`)),
          );
          process.exit(1);
          return;
        }
        if (!touched) {
          console.log(JSON.stringify(fail("MEMORY_NOT_FOUND", `No memory with id "${id}"`)));
          process.exit(1);
          return;
        }
        console.log(JSON.stringify(ok(touched)));
        return;
      }
      if (subcommand === "recall") {
        const query = Array.isArray(_args) ? _args.join(" ") : _args;
        if (!query) {
          console.log(JSON.stringify(fail("MISSING_ARG", "recall requires a query")));
          process.exit(1);
          return;
        }
        // the working retriever (keyword×salience + validity/supersede filters) —
        // CBM search_graph returns 0 over markdown-only projects (measured, see
        // scripts/memory-recall-eval.ts). Reinforces survivors so decay keeps them.
        const memDir = join(process.cwd(), ".graphkit", "memory");
        // Configured recall_topk takes precedence (graph.yaml topology_config.memory).
        let topk = 5;
        try {
          const graph = YAML.parse(readFileSync(join(process.cwd(), "graph.yaml"), "utf-8"));
          const memCfg = MemoryConfig.safeParse(graph?.topology_config?.memory);
          if (memCfg.success) topk = memCfg.data.recall_topk;
        } catch {
          /* no graph.yaml — default topk */
        }
        let results: ExpandedHit[] = [];
        let linked = 0;
        try {
          const stats = expandedRecall(memDir, query, topk);
          results = stats.results;
          linked = stats.linked;
        } catch (e) {
          console.log(
            JSON.stringify(
              fail("MEMORY_DIR_UNREADABLE", `memory store unreadable: ${String((e as Error)?.message ?? e)}`),
            ),
          );
          process.exit(1);
          return;
        }
        // Reinforcement reads/writes the same store as expandedRecall above —
        // a failure routes through the same fail() contract, not a raw throw.
        // O(k): each hit is touched by its known path (one read per hit), not
        // by rescanning the store.
        try {
          for (const h of results) _touchByPath(process.cwd(), h.path, h.id);
        } catch (e) {
          console.log(
            JSON.stringify(
              fail("MEMORY_DIR_UNREADABLE", `memory store unreadable: ${String((e as Error)?.message ?? e)}`),
            ),
          );
          process.exit(1);
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(ok({ query, top_k: results.length, results, linked, recall_topk: topk })));
          return;
        }
        console.log(renderRecallHits(memDir, query, results, linked));
        return;
      }
      if (subcommand !== "index") {
        console.log(
          JSON.stringify(
            fail("UNKNOWN_MEMORY_SUBCOMMAND", `Unknown memory subcommand "${subcommand}"`, {
              available: subcommandsFor("memory").split(" "),
            }),
          ),
        );
        process.exit(1);
        return;
      }
      try {
        const result = await indexMemory(process.cwd(), opts.project);
        console.log(JSON.stringify(ok(result)));
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        console.log(
          JSON.stringify(
            fail(
              "CBM_UNAVAILABLE",
              msg.includes("@graphkit/codebase-memory-mcp") ? msg : `${CBM_UNAVAILABLE_MSG}\n${msg}`,
            ),
          ),
        );
        process.exit(1);
      }
    });
}
