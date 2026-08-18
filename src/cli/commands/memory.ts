import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { type CbmClient, createCbmClient, CBM_UNAVAILABLE_MSG } from "../../cbm/client.js";
import { indexProject } from "../../cbm/index.js";
import { actRScore, shouldExpire } from "../../eval/forgetting.js";
import { recallTopK } from "../../eval/memory-recall.js";
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
  writeFileSync(join(cwd, ".graphkit", ".last-index"), watermark);
  const dirty = join(cwd, ".graphkit", ".memory-dirty");
  if (existsSync(dirty)) unlinkSync(dirty);
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

// Any memory-file mutation (touch bump, expiry rewrite) outdates the CBM
// index — flag it so gk-recall's freshness gate (step 0) actually fires.
// `.memory-dirty` is checked+cleared by indexMemory; it was previously
// never written, so mid-run curator writes were invisible to CBM search.
function markDirty(cwd: string) {
  writeFileSync(join(cwd, ".graphkit", ".memory-dirty"), String(Date.now()));
}

// Stage 5 of the memory pipeline (decay): score every memory with ACT-R and
// mark below-threshold entries expired. Expired files are rewritten in place,
// never deleted (audit rule from the curator contract). Every pass appends
// one JSONL row per memory to .graphkit/.trace-log — decay silently rewriting
// files in place is otherwise unauditable.
export function traceMemory(cwd: string, now = new Date().toISOString()): MemoryTraceReport {
  const memDir = join(cwd, ".graphkit", "memory");
  const report: MemoryTraceReport = { total: 0, live: 0, expired: 0, newly_expired: 0, superseded: 0, memories: [] };
  if (!existsSync(memDir)) return report;

  for (const file of readdirSync(memDir).filter((f) => f.endsWith(".md"))) {
    const path = join(memDir, file);
    const raw = readFileSync(path, "utf-8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
    report.total++;

    if (fm.superseded_by) {
      report.superseded++;
      report.memories.push({ id: String(fm.id ?? file), score: 0, state: "superseded", action: "superseded" });
      continue;
    }

    const tags = Array.isArray(fm.tags) ? fm.tags.length : 0;
    const links = (raw.match(/\[\[[^\]]+\]\]/g) ?? []).length;
    // ponytail: connectivity heuristic — neutral 0.5 with no signal, tags+wikilinks
    // normalized at 3 above that; upgrade to real graph degree if memory entries
    // ever get CBM-indexed edges.
    const connectivity = tags + links > 0 ? Math.min(1, (tags + links) / 3) : 0.5;
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
    // could never survive a 0.3 gate.
    if (!wasExpired && shouldExpire(score, 0.1)) {
      fm.expired = true;
      fm.valid_to = now;
      markDirty(cwd);
      writeFileSync(path, `---\n${YAML.stringify(fm)}---\n${raw.slice(m[0].length)}`);
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
    report.memories
      .map((m) => JSON.stringify({ ts: now, id: m.id, action: m.action, score: +m.score.toFixed(4) }))
      .join("\n") + "\n",
  );
  return report;
}

// Reinforcement: recall that surfaces a memory must bump its use_count and
// last_used_at, or ACT-R decay expires the entire store uniformly (~day 10 for
// neutral memories) regardless of recall value. Called by gk-recall survivors.
export function touchMemory(
  cwd: string,
  id: string,
  now = new Date().toISOString(),
): { id: string; file: string; use_count: number; last_used_at: string } | null {
  const memDir = join(cwd, ".graphkit", "memory");
  if (!existsSync(memDir)) return null;
  for (const file of readdirSync(memDir).filter((f) => f.endsWith(".md"))) {
    const path = join(memDir, file);
    const raw = readFileSync(path, "utf-8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
    if (String(fm.id ?? "") !== id && file.replace(/\.md$/, "") !== id) continue;
    const useCount = (typeof fm.use_count === "number" ? fm.use_count : 1) + 1;
    fm.use_count = useCount;
    fm.last_used_at = now;
    markDirty(cwd);
    writeFileSync(path, `---\n${YAML.stringify(fm)}---\n${raw.slice(m[0].length)}`);
    return { id: String(fm.id ?? id), file, use_count: useCount, last_used_at: now };
  }
  return null;
}

export function registerMemoryCommands(cli: CAC) {
  // cac (6.x) matches a single leading token only; "memory index" never
  // dispatches. Use one `memory` command with subcommand dispatch (like graph).
  cli
    .command("memory <subcommand> [args...]", `Memory commands\nSubcommands: ${subcommandsFor("memory")}`)
    .option("--project <project>", "CBM project name (default: graph.yaml memory.project or graph-kit-memory)")
    .option("--json", "JSON output")
    .action(async (subcommand, _args, opts) => {
      if (subcommand === "trace") {
        // decay pass: ACT-R score + expiry marking, no CBM needed
        console.log(JSON.stringify(ok(traceMemory(process.cwd()))));
        return;
      }
      if (subcommand === "touch") {
        const id = Array.isArray(_args) ? _args[0] : _args;
        const touched = id ? touchMemory(process.cwd(), String(id)) : null;
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
        const top = recallTopK(join(process.cwd(), ".graphkit", "memory"), query);
        for (const h of top) touchMemory(process.cwd(), h.id);
        console.log(JSON.stringify(ok({ query, top_k: top.length, results: top })));
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
          JSON.stringify(fail("CBM_UNAVAILABLE", msg.includes("@graphkit/codebase-memory-mcp") ? msg : `${CBM_UNAVAILABLE_MSG}\n${msg}`)),
        );
        process.exit(1);
      }
    });
}
