import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { CBM_UNAVAILABLE_MSG } from "../../cbm/client.js";
import { actRScore, shouldExpire } from "../../eval/forgetting.js";
import { docStatusFor, isSuggestionFrontmatter } from "../../eval/memory-recall.js";
import { consolidate } from "../../memory/consolidate.js";
import { explainRecall, type RecallExplanation } from "../../memory/explain-recall.js";
import { expandedRecall } from "../../memory/recall-expanded.js";
import { renderRecallAscii, renderRecallHtml } from "../../memory/render-recall.js";
import { readMemoryFile, walkMemoryFiles, writeMemoryFile } from "../../memory/store.js";
import { MemoryConfig, MemoryFileSchema } from "../../schemas/memory.schema.js";
import { seamClientFactory, seamIndexProject } from "../cbm-seam.js";
import { leafUsageFor, subcommandsFor } from "../command-registry.js";
import { resolveGraphPath } from "../graph-resolve.js";
import { emit, fail, ok } from "../output.js";

// project precedence: --project flag → resolved graph's topology_config.memory.project → default
/** Project name for memory scoping: the resolved graph's topology_config.memory
 *  project, falling back to "graph-kit-memory" when unresolvable/unset. The
 *  resolved graph may come from --graph, the active run, the session pointer,
 *  or ./graph.yaml. */
function resolveProject(cwd: string, override?: string): string {
  if (override) return override;
  try {
    const doc = YAML.parse(readFileSync(resolveGraphPath(cwd).path, "utf-8"));
    const project = doc?.topology_config?.memory?.project;
    return typeof project === "string" && project.length > 0 ? project : "graph-kit-memory";
  } catch {
    /* Unreadable/unset graph falls back to default */
  }
  return "graph-kit-memory";
}

export async function indexMemory(cwd: string, projectOverride?: string) {
  const project = resolveProject(cwd, projectOverride);
  const memDir = join(cwd, ".graphkit", "memory");
  mkdirSync(memDir, { recursive: true });

  const client = seamClientFactory()();
  try {
    await seamIndexProject()(client, { repoPath: memDir, name: project });
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
  malformed: number;
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
  const report: MemoryTraceReport = {
    total: 0,
    live: 0,
    expired: 0,
    newly_expired: 0,
    superseded: 0,
    malformed: 0,
    memories: [],
  };
  const files = walkMemoryFiles(memDir); // root + one sublevel, reserved names skipped
  if (files.length === 0) return report;

  const expireActive = opts?.expire_policy !== "manual";

  for (const { rel, path } of files) {
    const { fm, head, body, error } = readMemoryFile(path);
    if (error) {
      report.malformed++;
      continue;
    }
    // Suggestion files keep their proposal lifecycle (proposed|accepted|
    // dismissed) on disk; the doc-schema parse sees the mapped status and the
    // expiry write below restores the original.
    const suggestionShaped = isSuggestionFrontmatter(fm);
    const suggestionStatus = fm.status;
    // Strict schema parse before rewrites; malformed entries are counted but skipped.
    const base = rel.replace(/^.*\//, "").replace(/\.md$/, "");
    const legacyTags = Array.isArray(fm.tags)
      ? fm.tags
      : typeof fm.tags === "string"
        ? (() => {
            try {
              const parsed = YAML.parse(fm.tags);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          })()
        : [];
    const validated = MemoryFileSchema.safeParse({
      ...fm,
      tags: legacyTags,
      id: typeof fm.id === "string" && fm.id.trim() ? fm.id : base,
      type: typeof fm.type === "string" && fm.type.trim() ? fm.type : "knowledge",
      status: docStatusFor(fm),
    });
    if (!validated.success) {
      report.malformed++;
      continue;
    }
    Object.assign(fm, validated.data);
    if (suggestionShaped) fm.status = suggestionStatus; // disk keeps the suggestion lifecycle
    report.total++;

    if (fm.superseded_by) {
      report.superseded++;
      report.memories.push({ id: String(fm.id ?? base), score: 0, state: "superseded", action: "superseded" });
      continue;
    }

    const tags = Array.isArray(fm.tags) ? fm.tags.length : 0;
    const links = (`${head}\n${body}`.match(/\[\[[^\]]+\]\]/g) ?? []).length;
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
    // shouldExpire's default 0.1 is the operating point: three ≤1 factors
    // multiply, so a neutral memory (salience 0.5 × connectivity 0.5) scores
    // ~0.15 at peak. `expire_policy: manual` scores and reports only, never
    // mutates the store.
    if (!wasExpired && expireActive && shouldExpire(score)) {
      fm.expired = true;
      fm.valid_to = now;
      if (!suggestionShaped) fm.status = "deprecated"; // suggestions mark decay via expired+valid_to, not status
      writeMemoryFile(path, fm, body);
      report.expired++;
      report.newly_expired++;
      report.memories.push({ id: String(fm.id ?? base), score, state: "expired", action: "newly-expired" });
    } else if (wasExpired) {
      report.expired++;
      report.memories.push({ id: String(fm.id ?? base), score, state: "expired", action: "already-expired" });
    } else {
      report.live++;
      report.memories.push({ id: String(fm.id ?? base), score, state: "live", action: "kept" });
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
// neutral memories) regardless of recall value. Called by gk-recall survivors.
export function touchMemory(
  cwd: string,
  id: string,
  now = new Date().toISOString(),
): { id: string; file: string; use_count: number; last_used_at: string } | null {
  // Root plus one sublevel (patterns/, suggestions/) — subfolder entries must
  // get use_count reinforcement too, or decay eventually evicts every pattern.
  for (const { rel, path } of walkMemoryFiles(join(cwd, ".graphkit", "memory"))) {
    const { fm, body, error } = readMemoryFile(path);
    if (error) continue;
    const base = rel.replace(/^.*\//, "").replace(/\.md$/, "");
    if (String(fm.id ?? "") !== id && base !== id) continue;
    const useCount = (typeof fm.use_count === "number" ? fm.use_count : 1) + 1;
    fm.use_count = useCount;
    fm.last_used_at = now;
    const validated = MemoryFileSchema.safeParse({
      ...fm,
      id: typeof fm.id === "string" && fm.id.trim() ? fm.id : base,
      type: typeof fm.type === "string" && fm.type.trim() ? fm.type : "knowledge",
      status: docStatusFor(fm),
    });
    if (!validated.success) continue;
    // The status mapping is read-side only — persist the file's own suggestion
    // lifecycle so suggest/consolidate still see a valid SuggestionFileSchema entry.
    const out: Record<string, unknown> = validated.data;
    if (isSuggestionFrontmatter(fm)) out.status = fm.status;
    writeMemoryFile(path, out, body);
    return { id: String(fm.id ?? id), file: base, use_count: useCount, last_used_at: now };
  }
  return null;
}

export function registerMemoryCommands(cli: CAC) {
  // cac (6.x) matches a single leading token only; "memory index" never
  // dispatches. Use one `memory` command with subcommand dispatch (like graph).
  cli
    .command("memory [subcommand] [args...]", `Memory commands\nSubcommands: ${subcommandsFor("memory")}`)
    .option("--project <project>", "CBM project name (default: graph.yaml memory.project or graph-kit-memory)")
    .option("--json", "JSON output")
    .option("--explain", "Explain recall scoring and filter decisions (read-only)")
    .option("--html", "With --explain: render the explanation as a standalone HTML report")
    .option("--origin <origin>", "Origin marker for the recall capture log (e.g. cli, curator, agent)")
    .example(leafUsageFor("memory"))
    .action(async (subcommand, _args, opts) => {
      if (!subcommand) {
        // Bare `gk memory` prints usage and exits 0 — a documented surface, not an error.
        console.log(
          `gk memory — memory lifecycle commands\n\nUsage:\n  gk memory <subcommand> [args...]\n\nSubcommands:\n${leafUsageFor("memory")}\n\nOptions:\n  --project <project>  CBM project name\n  --json               JSON output\n\nRecall options:\n  --explain            Explain recall scoring and filter decisions (read-only)\n  --html               With --explain: render a standalone HTML report to .graphkit/diagrams/\n  --origin <origin>    Origin marker for the recall capture log (e.g. cli, curator, agent)`,
        );
        return;
      }
      if (subcommand === "consolidate") {
        emit(ok(consolidate(process.cwd())));
        return;
      }
      if (subcommand === "trace") {
        // decay pass: ACT-R score + expiry marking, no CBM needed
        emit(ok(traceMemory(process.cwd())));
        return;
      }
      if (subcommand === "touch") {
        const id = Array.isArray(_args) ? _args[0] : _args;
        const touched = id ? touchMemory(process.cwd(), String(id)) : null;
        if (!touched) {
          emit(fail("MEMORY_NOT_FOUND", `No memory with id "${id}"`));
          return;
        }
        emit(ok(touched));
        return;
      }
      if (subcommand === "recall") {
        const query = Array.isArray(_args) ? _args.join(" ") : _args;
        if (!query) {
          emit(fail("MISSING_ARG", "recall requires a query"));
          return;
        }
        if (opts.html && !opts.explain) {
          emit(fail("INVALID_OPTION", "--html requires --explain"));
          return;
        }
        // the working retriever (keyword×salience + validity/supersede filters) —
        // CBM search_graph returns 0 over markdown-only projects (measured, see
        // scripts/memory-recall-eval.ts). Reinforces survivors so decay keeps them.
        const memDir = join(process.cwd(), ".graphkit", "memory");
        // Configured recall_topk takes precedence (graph.yaml topology_config.memory).
        let topk = 5;
        try {
          const graph = YAML.parse(readFileSync(resolveGraphPath(process.cwd()).path, "utf-8"));
          const memCfg = MemoryConfig.safeParse(graph?.topology_config?.memory);
          if (memCfg.success) topk = memCfg.data.recall_topk;
        } catch {
          /* nothing resolvable — default topk */
        }
        if (opts.explain) {
          // Explain mode is a read-only lens: no touchMemory reinforcement, no
          // .recall-log.jsonl capture — inspecting scoring must not move it.
          let exp: RecallExplanation;
          try {
            exp = explainRecall(memDir, query, topk);
          } catch (e) {
            emit(fail("MEMORY_DIR_UNREADABLE", `memory store unreadable: ${String((e as Error)?.message ?? e)}`));
            return;
          }
          if (opts.html) {
            // Spec §6: a failed report write must never block the CLI pipeline —
            // degrade to the ASCII rendering with a stderr warning, exit 0.
            try {
              const qSlug =
                query
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "") || "query";
              const stamp = new Date().toISOString().replace(/[:.]/g, "-");
              const relDir = join(".graphkit", "diagrams");
              mkdirSync(join(process.cwd(), relDir), { recursive: true });
              const relPath = join(relDir, `recall-${qSlug}-${stamp}.html`);
              writeFileSync(join(process.cwd(), relPath), renderRecallHtml(exp));
              console.log(relPath);
            } catch (e) {
              console.error(`warning: failed to write HTML report: ${String((e as Error)?.message ?? e)}`);
              console.log(renderRecallAscii(exp));
            }
            return;
          }
          if (opts.json) {
            emit(ok(exp));
            return;
          }
          console.log(renderRecallAscii(exp));
          return;
        }
        let results: Array<{ id: string; file: string; salience: number; linked: boolean }> = [];
        let linked = 0;
        let scanned = 0;
        try {
          const stats = expandedRecall(memDir, query, topk);
          results = stats.results;
          linked = stats.linked;
          scanned = stats.scanned;
        } catch (e) {
          emit(fail("MEMORY_DIR_UNREADABLE", `memory store unreadable: ${String((e as Error)?.message ?? e)}`));
          return;
        }
        for (const h of results) touchMemory(process.cwd(), h.id);
        // Capture log: one JSONL row per real recall (never with --explain) so
        // downstream tooling can replay retrieval decisions.
        mkdirSync(memDir, { recursive: true });
        appendFileSync(
          join(memDir, ".recall-log.jsonl"),
          `${JSON.stringify({
            ts: new Date().toISOString(),
            query,
            k: topk,
            origin: typeof opts.origin === "string" && opts.origin ? opts.origin : "cli",
            top: results.map((h) => ({ id: h.id, salience: h.salience })),
            injected: true,
            scanned,
          })}\n`,
        );
        emit(ok({ query, returned: results.length, results, linked, recall_topk: topk }));
        return;
      }
      if (subcommand !== "index") {
        emit(
          fail("UNKNOWN_MEMORY_SUBCOMMAND", `Unknown memory subcommand "${subcommand}"`, {
            available: subcommandsFor("memory").split(" "),
          }),
        );
        return;
      }
      try {
        const result = await indexMemory(process.cwd(), opts.project);
        emit(ok(result));
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        emit(
          fail(
            "CBM_UNAVAILABLE",
            msg.includes("@graphkit/codebase-memory-mcp") ? msg : `${CBM_UNAVAILABLE_MSG}\n${msg}`,
          ),
        );
      }
    });
}
