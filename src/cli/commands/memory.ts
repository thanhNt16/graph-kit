import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { type CbmClient, createCbmClient } from "../../cbm/client.js";
import { indexProject } from "../../cbm/index.js";
import { actRScore, shouldExpire } from "../../eval/forgetting.js";
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

// Stage 5 of the memory pipeline (decay): score every memory with ACT-R and
// mark below-threshold entries expired. Expired files are rewritten in place,
// never deleted (audit rule from the curator contract).
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
  return report;
}

export function registerMemoryCommands(cli: CAC) {
  // cac (6.x) matches a single leading token only; "memory index" never
  // dispatches. Use one `memory` command with subcommand dispatch (like graph).
  cli
    .command("memory <subcommand> [args...]", "Memory index commands")
    .option("--project <project>", "CBM project name (default: graph.yaml memory.project or graph-kit-memory)")
    .option("--json", "JSON output")
    .action(async (subcommand, _args, opts) => {
      if (subcommand === "trace") {
        // decay pass: ACT-R score + expiry marking, no CBM needed
        console.log(JSON.stringify(ok(traceMemory(process.cwd()))));
        return;
      }
      if (subcommand !== "index") {
        console.log(
          JSON.stringify(
            fail("UNKNOWN_MEMORY_SUBCOMMAND", `Unknown memory subcommand "${subcommand}"`, {
              available: ["index", "trace"],
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
        console.log(JSON.stringify(fail("CBM_UNAVAILABLE", String(e))));
        process.exit(1);
      }
    });
}
