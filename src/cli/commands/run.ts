import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { GraphKitError } from "../../errors.js";
import { analyzeRun } from "../../memory/analyze.js";
import {
  activeRun,
  activeRunPointer,
  appendAdvisor,
  appendDispatch,
  appendNode,
  clearActiveRun,
  type DispatchLine,
  endRun,
  landNode,
  readAdvisorEvents,
  readDispatches,
  readRunMeta,
  stampTakeover,
  startRun,
} from "../../memory/ledger.js";
import { recordRound } from "../../memory/loops.js";
import { reconcileRun, resumeRun } from "../../memory/resume.js";
import { GraphSchema } from "../../schemas/graph.schema.js";
import { leafUsageFor, subcommandsFor } from "../command-registry.js";
import { parseInputs, recordRunInputs, requiredMissing } from "../graph-inputs.js";
import { resolveGraphPath } from "../graph-resolve.js";
import { emit, fail, ok } from "../output.js";
import { kitVersionWarnings } from "./kit.js";

/** `gk run end` contract: report leftover worktrees/branches so the orchestrator
 * cleans them before reporting completion. Best-effort: [] on non-git or any
 * scan failure — ending a run must never block on housekeeping data. */
function orphanedGkArtifacts(cwd: string): { orphaned_worktrees: string[]; orphaned_branches: string[] } {
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" });
    const worktrees = git(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .filter((p) => p.includes(".graphkit/worktrees/"));
    const branches = git(["branch", "--list", "gk/*"])
      .split("\n")
      .map((l) => l.replace(/^[\s*+]\s*/, "").trim())
      .filter(Boolean);
    return { orphaned_worktrees: worktrees, orphaned_branches: branches };
  } catch {
    return { orphaned_worktrees: [], orphaned_branches: [] };
  }
}

function errCode(e: unknown): { code: string; message: string } {
  const message = String((e as Error)?.message ?? e);
  const code = message.match(/^([A-Z_]+):/)?.[1] ?? "RUN_ERROR";
  return { code, message };
}

/** ENOENT on a graph is a coded condition, not a raw errno leaking into the envelope. */
function readGraphFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`GRAPH_FILE_NOT_FOUND: ${path}`);
    throw e;
  }
}

/** Schema-validated graph document, failing with the envelope's SCHEMA_INVALID code. */
function parseGraphData(graphPath: string) {
  const parsed = GraphSchema.safeParse(YAML.parse(readGraphFile(graphPath)));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`SCHEMA_INVALID: ${issues}`);
  }
  return parsed.data;
}

/** Node ids of the graph the run actually executes — resolved through the ONE
 *  graph resolver: explicit --graph (file or session id) wins, then the active
 *  run's recorded graph. null when nothing resolves (no active run / legacy
 *  meta): callers skip validation rather than guess a graph the run never
 *  recorded. */
function runGraphNodeIds(cwd: string, flag: string | undefined): { path: string; ids: string[] } | null {
  try {
    const graphPath = resolveGraphPath(cwd, flag).path;
    return { path: graphPath, ids: Object.keys(parseGraphData(graphPath).nodes) };
  } catch (e) {
    if (e instanceof GraphKitError && e.code === "NO_ACTIVE_GRAPH") return null;
    throw e;
  }
}

/** Pids of `dispatches` that still have a live process. Only ESRCH means gone:
 *  EPERM is a live pid we may not signal (foreign user) and must block
 *  takeover. Non-positive pids are legacy junk (pid 0 signals our own process
 *  group) and never count as live. Exported for tests — the EPERM/ESRCH split
 *  is the takeover safety contract. */
export function liveDispatchPids(
  dispatches: DispatchLine[],
  isAlive: (pid: number) => boolean = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
): number[] {
  return dispatches
    .filter((d) => d.pid != null && Number.isInteger(d.pid) && d.pid > 0 && d.pid !== process.pid)
    .map((d) => d.pid!)
    .filter((pid) => isAlive(pid));
}

export function registerRunCommands(cli: CAC) {
  cli
    .command("run [subcommand] [args...]", `Run ledger commands\nSubcommands: ${subcommandsFor("run")}`)
    .option("--graph <path>", "graph.yaml path (default: ./graph.yaml)")
    // ==== FixGraph slice (audit F4): --input wiring — helpers in cli/graph-inputs.ts ====
    .option("--input <pair>", "run input as k=v (repeatable; enforced against graph.inputs)")
    .option("--status <status>", "node: ok|fail|skipped|challenge — end: merged|blocked|failed")
    .option("--advisor-fired <round>", "record advisor firing for a node")
    .option("--streak <n>", "advisor failure streak")
    .option("--wave <n>", "wave index")
    .option("--agent <agent>", "agent id")
    .option("--model <model>", "model tier")
    .option("--evidence <keys>", "comma-separated evidence keys")
    .option("--duration-ms <n>", "node duration in ms")
    .option("--notes <text>", "free-text note")
    .option("--json", "JSON output")
    .option("--from-node <id>", "resume: redo this node + dependents")
    .option("--dry-run", "resume: preview without writing")
    .option("--force", "resume: override graph drift guard")
    .option("--attempt <n>", "node/dispatch: attempt number")
    .option("--commit <sha>", "land: integration commit")
    .option("--via <via>", "dispatch: task|extension")
    .option("--pid <pid>", "dispatch: child pid")
    .option("--from <run>", "take: run id to take over")
    .example(leafUsageFor("run"))
    .action((subcommand, args, opts) => {
      const cwd = process.cwd();
      if (!subcommand) {
        console.log(
          `gk run — run ledger commands\n\nUsage:\n  gk run <subcommand> [args...]\n\nSubcommands:\n${leafUsageFor("run")}`,
        );
        return;
      }
      try {
        if (subcommand === "start") {
          let graphPath: string;
          try {
            graphPath = resolveGraphPath(cwd, opts.graph).path;
          } catch (e) {
            if (!(e instanceof GraphKitError)) throw e;
            emit(fail(e.code, e.message, e.details));
            return;
          }
          // ==== FixGraph slice (audit F4): --input enforcement — the only
          // ==== run.ts lines this slice touches (helpers: cli/graph-inputs.ts).
          const provided = parseInputs(opts.input);
          const missing = requiredMissing(graphPath, provided);
          if (missing.length > 0) {
            emit(
              fail("MISSING_INPUTS", `required input(s) have no default and no --input value: ${missing.join(", ")}`, {
                missing,
              }),
            );
            return;
          }
          const started = startRun(cwd, graphPath);
          if (Object.keys(provided).length > 0) recordRunInputs(started.dir, provided);
          // Stale-kit installs run outdated skills/extensions (observed: a run
          // executed with a pre-orchestration-fields gk-execute). Surface it at
          // the one moment the orchestrator is guaranteed to look — run start.
          const warnings = kitVersionWarnings(cwd);
          emit(ok(warnings.length ? { ...started, warnings } : started));
          return;
        }
        if (subcommand === "node") {
          const node = Array.isArray(args) ? args[0] : args;
          if (!node) {
            emit(fail("MISSING_ARG", "node requires a node id"));
            return;
          }
          // Advisor-fired mode needs no --status: the firing itself is the trace line.
          if (opts.advisorFired != null) {
            const round = Number(opts.advisorFired);
            // tier is derived from the graph's node.advisor.model (spec §5)
            if (!Number.isInteger(round) || round < 1) {
              emit(fail("BAD_ADVISOR", "--advisor-fired requires an integer round >= 1"));
              return;
            }
            const streak = opts.streak == null ? null : Number(opts.streak);
            if (streak !== null && (!Number.isInteger(streak) || streak < 1)) {
              emit(fail("BAD_ADVISOR", "--streak requires an integer >= 1"));
              return;
            }
            // Tier source: resolved through the ONE graph resolver — explicit
            // --graph wins, then the active run's recorded graph (what the run
            // actually executes), then session pointer / root graph.yaml.
            const graphPath = resolveGraphPath(cwd, opts.graph).path;
            const parsedData = parseGraphData(graphPath);
            const advisor = parsedData.nodes[String(node)]?.advisor;
            if (!advisor) {
              emit(fail("BAD_ADVISOR", `node "${node}" has no advisor config in ${graphPath}`));
              return;
            }
            emit(
              ok(
                appendAdvisor(cwd, {
                  node: String(node),
                  round,
                  tier: advisor.model,
                  streak,
                }),
              ),
            );
            return;
          }
          if (
            opts.status !== "ok" &&
            opts.status !== "fail" &&
            opts.status !== "skipped" &&
            opts.status !== "challenge"
          ) {
            emit(fail("BAD_STATUS", "node requires --status ok|fail|skipped|challenge"));
            return;
          }
          // Phantom nodes corrupt the ledger and inflate node_count: every
          // traced id must exist in the graph the active run recorded.
          const g = runGraphNodeIds(cwd, opts.graph);
          if (g && !g.ids.includes(String(node))) {
            emit(fail("UNKNOWN_NODE", `node '${node}' not in graph ${g.path}`, { available: g.ids }));
            return;
          }
          const result = appendNode(cwd, {
            node: String(node),
            wave: opts.wave == null ? null : Number(opts.wave),
            agent: opts.agent ?? null,
            model: opts.model ?? null,
            status: opts.status,
            evidence: opts.evidence
              ? String(opts.evidence)
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [],
            duration_ms: opts.durationMs == null ? null : Number(opts.durationMs),
            attempt: opts.attempt == null ? undefined : Number(opts.attempt),
            notes: opts.notes ?? null,
          });
          emit(ok(result));
          return;
        }
        if (subcommand === "dispatch") {
          const node = Array.isArray(args) ? args[0] : args;
          if (!node) {
            emit(fail("MISSING_ARG", "dispatch requires a node id"));
            return;
          }
          if (opts.via != null && !["task", "extension"].includes(String(opts.via))) {
            emit(fail("BAD_VIA", "--via must be task|extension"));
            return;
          }
          const g = runGraphNodeIds(cwd, opts.graph);
          if (g && !g.ids.includes(String(node))) {
            emit(fail("UNKNOWN_NODE", `node '${node}' not in graph ${g.path}`, { available: g.ids }));
            return;
          }
          emit(
            ok(
              appendDispatch(cwd, {
                node: String(node),
                attempt: opts.attempt == null ? null : Number(opts.attempt),
                via: opts.via ?? "task",
                pid: opts.pid == null ? null : Number(opts.pid),
              }),
            ),
          );
          return;
        }
        if (subcommand === "land") {
          const node = Array.isArray(args) ? args[0] : args;
          if (!node || !opts.commit) {
            emit(fail("MISSING_ARG", "land requires a node id and --commit <sha>"));
            return;
          }
          const g = runGraphNodeIds(cwd, opts.graph);
          if (g && !g.ids.includes(String(node))) {
            emit(fail("UNKNOWN_NODE", `node '${node}' not in graph ${g.path}`, { available: g.ids }));
            return;
          }
          emit(ok(landNode(cwd, String(node), String(opts.commit))));
          return;
        }
        if (subcommand === "take") {
          const target = opts.from ?? (Array.isArray(args) ? args[0] : args);
          if (!target) {
            emit(fail("MISSING_ARG", "take requires --from <run-id>"));
            return;
          }
          // Refuse takeover while the old run's recorded pids are alive.
          const live = liveDispatchPids(readDispatches(cwd, String(target)));
          if (live.length > 0) {
            emit(fail("TAKEOVER_BLOCKED", `run ${target} has live dispatch pids: ${live.join(", ")}`));
            return;
          }
          // Dangling .active: the pointer names this run but its dir is gone.
          // Nothing to reconcile — clearing the pointer IS the recovery. Gated
          // on the pointer itself so bogus ids still get RESUME_RUN_NOT_FOUND.
          const ptr = activeRunPointer(cwd);
          if (ptr?.dangling && basename(ptr.dir) === String(target)) {
            clearActiveRun(cwd);
            emit(
              ok({
                taken_from: target,
                pending: [],
                unresolved: [],
                foreign_evidence: [],
                active_cleared: true,
                active: null,
                dangling: true,
                note: `run ${target} recorded in .graphkit/runs/.active has no run directory — pointer cleared, nothing to reconcile`,
              }),
            );
            return;
          }
          // Reconcile first so the takeover payload carries truth, then clear.
          const rec = reconcileRun(cwd, String(target), { force: opts.force });
          const active = activeRun(cwd);
          const cleared = active != null && basename(active) === String(target);
          if (cleared) clearActiveRun(cwd);
          stampTakeover(cwd, String(target));
          emit(
            ok({
              taken_from: target,
              unresolved: rec.unresolved,
              pending: rec.pending,
              foreign_evidence: rec.foreign_evidence,
              active_cleared: cleared,
              active: active ? basename(active) : null,
            }),
          );
          return;
        }
        if (subcommand === "end") {
          const status = opts.status ?? "merged";
          if (!["merged", "blocked", "failed"].includes(status)) {
            emit(fail("BAD_STATUS", "end requires --status merged|blocked|failed"));
            return;
          }
          emit(ok({ ...endRun(cwd, status), ...orphanedGkArtifacts(cwd) }));
          return;
        }
        if (subcommand === "resume") {
          const target = Array.isArray(args) ? args[0] : args;
          if (!target) {
            emit(fail("MISSING_ARG", "resume requires a run id"));
            return;
          }
          try {
            emit(
              ok(resumeRun(cwd, String(target), { fromNode: opts.fromNode, dryRun: opts.dryRun, force: opts.force })),
            );
          } catch (e) {
            const { code, message } = errCode(e);
            emit(fail(code, message));
          }
          return;
        }
        if (subcommand === "round") {
          const arg = Array.isArray(args) ? args[0] : args;
          const idx = Number(arg);
          if (arg == null || arg === "") {
            emit(fail("MISSING_ARG", "round requires a loop-group index"));
            return;
          }
          if (!Number.isInteger(idx) || idx < 0) {
            emit(fail("BAD_ARG", "round requires an integer loop-group index >= 0"));
            return;
          }
          try {
            emit(ok(recordRound(cwd, idx)));
          } catch (e) {
            const { code, message } = errCode(e);
            emit(fail(code, message));
          }
          return;
        }
        if (subcommand === "status") {
          const ptr = activeRunPointer(cwd);
          const dir = ptr && !ptr.dangling ? ptr.dir : null;
          const advisor_events = dir ? readAdvisorEvents(cwd, basename(dir)).length : 0;
          const chain: string[] = [];
          let cursor: string | null = dir ? basename(dir) : null;
          const guard = new Set<string>();
          while (cursor && !guard.has(cursor)) {
            guard.add(cursor);
            chain.push(cursor);
            try {
              cursor = readRunMeta(cwd, cursor).resumes ?? null;
            } catch {
              cursor = null;
            }
          }
          const meta = dir ? readRunMeta(cwd, basename(dir)) : null;
          emit(
            ok({
              active: dir,
              active_age_ms: meta ? Date.now() - Date.parse(meta.started_at) : null,
              advisor_events,
              resumes_chain: chain,
              ...(ptr?.dangling ? { dangling: true, dangling_run: basename(ptr.dir) } : {}),
            }),
          );
          return;
        }
        if (subcommand === "analyze") {
          const target = Array.isArray(args) ? args[0] : args;
          try {
            emit(ok(analyzeRun(cwd, target == null || target === "" ? undefined : String(target))));
          } catch (e) {
            const { code, message } = errCode(e);
            emit(fail(code, message));
          }
          return;
        }
        emit(
          fail("UNKNOWN_RUN_SUBCOMMAND", `Unknown run subcommand "${subcommand}"`, {
            available: subcommandsFor("run").split(" "),
          }),
        );
      } catch (e) {
        const { code, message } = errCode(e);
        emit(fail(code, message));
      }
    });
}
