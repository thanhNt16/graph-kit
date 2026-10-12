import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CAC } from "cac";
import { isBlocking, validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import { parseMarker } from "../../evidence/marker.js";
import { learnIndex, learnRunSummary } from "../../learn/index.js";
import { runLifecycle } from "../../memory/lifecycle-store.js";
import { analyzeRun } from "../../runs/analyze.js";
import { budgetStatus, declaredNodeBudget } from "../../runs/budget.js";
import {
  activeRun,
  activeRunPointer,
  appendAdvisor,
  appendDispatch,
  appendNode,
  appendProgress,
  clearActiveRun,
  type DispatchLine,
  endRun,
  isNodeLine,
  landNode,
  progressTail,
  readAdvisorEvents,
  readDispatches,
  readProgress,
  readRunMeta,
  readTrace,
  stampTakeover,
  startRun,
  verifyTraceChain,
} from "../../runs/ledger.js";
import { recordPoll, recordRound } from "../../runs/loops.js";
import { writeRunReport } from "../../runs/report.js";
import { reconcileRun, resumeRun } from "../../runs/resume.js";
import type { Graph } from "../../schemas/graph.schema.js";
import { MemoryConfig, MemoryLifecycleConfig } from "../../schemas/memory.schema.js";
import { leafUsageFor, subcommandsFor } from "../command-registry.js";
import { toGraphKitError } from "../diagnostics.js";
import { parseInputs, recordRunInputs, requiredMissing } from "../graph-inputs.js";
import { resolveGraphPath } from "../graph-resolve.js";
import { emit, fail, ok } from "../output.js";
import { loadGraph } from "./graph.js";
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

/** Node ids of the graph the run actually executes — resolved through the ONE
 *  graph resolver: explicit --graph (file or session id) wins, then the active
 *  run's recorded graph. null when nothing resolves (no active run / legacy
 *  meta): callers skip validation rather than guess a graph the run never
 *  recorded. */
function runGraphNodeIds(cwd: string, flag: string | undefined): { path: string; ids: string[] } | null {
  try {
    const graphPath = resolveGraphPath(cwd, flag).path;
    return { path: graphPath, ids: Object.keys(loadGraph(graphPath).nodes) };
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

/** `--evidence` half of `gk run verify`: re-hash every artifact file the run's
 *  evidence markers pinned (marker run_id === run id) and flag byte drift or
 *  missing files. Markers are the signed claims; artifacts are the bytes. */
function verifyRunEvidence(
  cwd: string,
  id: string,
  graphFlag?: string,
): { checked: number; mismatches: { key: string; artifact: string; expected: string; actual: string | null }[] } {
  const meta = readRunMeta(cwd, id);
  const graphPath = meta.graph_path ?? resolveGraphPath(cwd, graphFlag).path;
  const evidenceDir = join(cwd, loadGraph(graphPath).outputs.evidence_dir);
  const mismatches: { key: string; artifact: string; expected: string; actual: string | null }[] = [];
  let checked = 0;
  if (!existsSync(evidenceDir)) return { checked, mismatches };
  for (const file of readdirSync(evidenceDir).filter((f) => f.endsWith(".md"))) {
    const marker = parseMarker(readFileSync(join(evidenceDir, file), "utf-8"));
    if (!marker || marker.run_id !== id || !marker.artifact || !marker.artifact_sha256) continue;
    checked++;
    const abs = join(evidenceDir, marker.artifact);
    const actual = existsSync(abs) ? createHash("sha256").update(readFileSync(abs)).digest("hex") : null;
    if (actual !== marker.artifact_sha256)
      mismatches.push({ key: marker.key, artifact: marker.artifact, expected: marker.artifact_sha256, actual });
  }
  // Deleting a marker must not silently verify: every evidence key the run's
  // node lines claimed needs its marker file to exist on disk.
  for (const key of new Set(
    readTrace(cwd, id)
      .filter(isNodeLine)
      .flatMap((l) => l.evidence),
  )) {
    if (!existsSync(join(evidenceDir, `${key}.md`)))
      mismatches.push({ key, artifact: `${key}.md`, expected: "marker file", actual: null });
  }
  return { checked, mismatches };
}

export function registerRunCommands(cli: CAC) {
  cli
    .command("run [subcommand] [...args]", `Run ledger commands\nSubcommands: ${subcommandsFor("run")}`)
    .option("--graph <path>", "graph.yaml path (default: ./graph.yaml)")
    // ==== FixGraph slice (audit F4): --input wiring — helpers in cli/graph-inputs.ts ====
    .option("--input <pair>", "run input as k=v (repeatable; enforced against graph.inputs)")
    .option("--status <status>", "node: ok|fail|skipped|challenge — end: merged|blocked|failed")
    .option("--advisor-fired <round>", "record advisor firing for a node")
    .option("--streak <n>", "advisor failure streak")
    .option("--wave <n>", "wave index")
    .option("--agent <agent>", "agent id")
    .option("--model <model>", "model tier")
    .option("--evidence [keys]", "node: comma-separated evidence keys — verify: re-hash run evidence artifacts")
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
    .option("--node <id>", "progress: node id the note is attributed to")
    .option("--tail <n>", "progress: print only the last N lines")
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
          // Audit CS#1: resolve + validate BEFORE any ledger state exists —
          // an invalid graph must never produce runs/<id>/ or .active. Schema
          // failures die as SCHEMA_INVALID (loadGraph), semantic + environment
          // probes as VALIDATION_FAILED (validateGraph) — both before startRun.
          let graphPath: string;
          let graph: Graph;
          try {
            const resolved = resolveGraphPath(cwd, opts.graph);
            graphPath = resolved.path;
            graph = loadGraph(resolved.path);
          } catch (e) {
            if (!(e instanceof GraphKitError)) throw e;
            emit(fail(e.code, e.message, e.details));
            return;
          }
          const findings = validateGraph(graph, cwd);
          if (findings.some(isBlocking)) {
            emit(fail("VALIDATION_FAILED", "graph has findings", { issues: findings }));
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
          // The graph's declared budget is recorded into the run's meta so
          // status/enforcement read it even if graph.yaml later drifts.
          const started = startRun(cwd, graphPath, undefined, undefined, graph.budget);
          if (Object.keys(provided).length > 0) recordRunInputs(started.dir, provided);
          // Stale-kit installs run outdated skills/extensions (observed: a run
          // executed with a pre-orchestration-fields gk-execute). Surface it at
          // the one moment the orchestrator is guaranteed to look — run start.
          const warnings = kitVersionWarnings(cwd);
          // Cheap single scan: the adherence lifecycle also runs once per run
          // start so the learned-artifact store stays bounded between manual
          // `gk memory lifecycle` passes. Advisory only — a corrupt memory
          // store must never block run start.
          try {
            const memCfg = MemoryConfig.safeParse(graph.topology_config?.memory);
            const scan = runLifecycle(cwd, MemoryLifecycleConfig.parse(memCfg.success ? memCfg.data.lifecycle : {}));
            if (scan.archived > 0) warnings.push(`lifecycle archived ${scan.archived} learned item(s)`);
          } catch {
            /* advisory — never block startRun */
          }
          // Learned-items index rides run start the same way the progress
          // recitation rides briefs: run-start context sees landed patterns.
          const learnIdx = learnIndex(cwd, graph.learn_index_tail);
          emit(
            ok({
              ...started,
              ...(learnIdx ? { learn_index: learnIdx } : {}),
              ...(warnings.length ? { warnings } : {}),
            }),
          );
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
            const parsedData = loadGraph(graphPath);
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
            evidence:
              typeof opts.evidence === "string"
                ? opts.evidence
                    .split(",")
                    .map((s: string) => s.trim())
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
          // Host-driven runs honor the same declared cap the engine enforces:
          // charging this node's budget_tokens must not push allocated past
          // max. Re-dispatch of an already-counted node charges 0 (retries
          // never double-spend — budgetStatus dedupes by node id).
          {
            const dir = activeRun(cwd);
            const runId = dir ? basename(dir) : null;
            const meta = runId ? readRunMeta(cwd, runId) : null;
            const budget = runId && meta ? budgetStatus(cwd, runId, meta) : null;
            if (budget) {
              const charge = declaredNodeBudget(meta?.graph_path, String(node));
              const alreadyDispatched =
                readDispatches(cwd, runId!).some((d) => d.node === String(node)) ||
                readTrace(cwd, runId!).some((l) => isNodeLine(l) && l.node === String(node));
              const projected = budget.allocated + (alreadyDispatched ? 0 : charge);
              if (projected > budget.max) {
                emit(
                  fail("BUDGET_EXCEEDED", `dispatch of '${node}' would exceed the run's context budget`, {
                    run_id: runId,
                    node: String(node),
                    charge,
                    allocated: budget.allocated,
                    projected,
                    max: budget.max,
                  }),
                );
                return;
              }
            }
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
          // An over-budget run may not close as merged — the cap is part of
          // the run's contract, not advisory telemetry.
          if (status === "merged") {
            const dir = activeRun(cwd);
            const runId = dir ? basename(dir) : null;
            const meta = runId ? readRunMeta(cwd, runId) : null;
            const budget = runId && meta ? budgetStatus(cwd, runId, meta) : null;
            if (budget?.exceeded) {
              emit(
                fail(
                  "BUDGET_EXCEEDED",
                  `run ${runId} allocated ${budget.allocated}/${budget.max} declared tokens — end it blocked|failed, not merged`,
                  {
                    run_id: runId,
                    ...budget,
                  },
                ),
              );
              return;
            }
          }
          const ended = endRun(cwd, status);
          // Every closed run leaves a reviewable HTML record. Advisory:
          // a render failure must never block the run's closing.
          let report: string | null = null;
          try {
            report = writeRunReport(cwd, ended.id);
          } catch {
            /* report is best-effort */
          }
          emit(ok({ ...ended, ...(report ? { report } : {}), ...orphanedGkArtifacts(cwd) }));
          return;
        }
        if (subcommand === "report") {
          const target = Array.isArray(args) ? args[0] : args;
          if (!target) {
            emit(fail("MISSING_ARG", "report requires a run id"));
            return;
          }
          try {
            emit(ok({ run: String(target), report: writeRunReport(cwd, String(target)) }));
          } catch (e) {
            const gke = toGraphKitError(e, "RUN_ERROR");
            emit(fail(gke.code, gke.message, gke.details));
          }
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
            const gke = toGraphKitError(e, "RUN_ERROR");
            emit(fail(gke.code, gke.message, gke.details));
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
            const gke = toGraphKitError(e, "RUN_ERROR");
            emit(fail(gke.code, gke.message, gke.details));
          }
          return;
        }
        if (subcommand === "poll") {
          const arg = Array.isArray(args) ? args[0] : args;
          const idx = Number(arg);
          if (arg == null || arg === "") {
            emit(fail("MISSING_ARG", "poll requires a loop-group index"));
            return;
          }
          if (!Number.isInteger(idx) || idx < 0) {
            emit(fail("BAD_ARG", "poll requires an integer loop-group index >= 0"));
            return;
          }
          try {
            emit(ok(recordPoll(cwd, idx)));
          } catch (e) {
            const gke = toGraphKitError(e, "RUN_ERROR");
            emit(fail(gke.code, gke.message, gke.details));
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
          const budget = dir && meta ? budgetStatus(cwd, basename(dir), meta) : null;
          // Learn proposals this run produced — rejected ones stay visible
          // here instead of disappearing from the account.
          const learn = dir ? learnRunSummary(cwd, basename(dir)) : null;
          emit(
            ok({
              active: dir,
              active_age_ms: meta ? Date.now() - Date.parse(meta.started_at) : null,
              advisor_events,
              resumes_chain: chain,
              // Planning-currency accounting over declared budget_tokens —
              // present only when the run recorded a graph budget.
              ...(budget ? { budget } : {}),
              ...(learn ? { learn } : {}),
              ...(ptr?.dangling ? { dangling: true, dangling_run: basename(ptr.dir) } : {}),
            }),
          );
          return;
        }
        if (subcommand === "progress") {
          const list = Array.isArray(args) ? args : [args];
          const target = list[0];
          const note = list.slice(1).join(" ").trim();
          if (!target) {
            emit(fail("MISSING_ARG", "progress requires a run id"));
            return;
          }
          if (note) {
            emit(ok(appendProgress(cwd, String(target), note, opts.node == null ? undefined : String(opts.node))));
            return;
          }
          // Read mode: whole file, or the last --tail N progress entries.
          // Plain stdout (like `graph ascii`) — the file IS the payload.
          readRunMeta(cwd, String(target)); // RUN_NOT_FOUND parity for bogus ids
          if (opts.tail != null) {
            const n = Number(opts.tail);
            if (!Number.isInteger(n) || n < 0) {
              emit(fail("BAD_ARG", "--tail requires an integer >= 0"));
              return;
            }
            console.log(progressTail(cwd, String(target), n).join("\n"));
          } else {
            console.log((readProgress(cwd, String(target)) ?? "").replace(/\n+$/, ""));
          }
          return;
        }
        if (subcommand === "verify") {
          const target = Array.isArray(args) ? args[0] : args;
          if (!target) {
            emit(fail("MISSING_ARG", "verify requires a run id"));
            return;
          }
          try {
            const chain = verifyTraceChain(cwd, String(target));
            // --evidence: re-hash every artifact this run's markers stamped.
            // A bare trailing `--evidence` parses as boolean true; a value form
            // is accepted too (node shares the flag for evidence keys).
            const wantEvidence = opts.evidence != null && opts.evidence !== false;
            let evidence: { checked: number; mismatches: unknown[] } | null = null;
            if (wantEvidence) evidence = verifyRunEvidence(cwd, String(target), opts.graph);
            if (!chain.ok) {
              const d = chain.divergence!;
              emit(
                fail("RUN_TAMPERED", `run ${target} trace diverges at line ${d.index} (${d.kind})`, {
                  run: target,
                  ...chain,
                  ...(evidence ? { evidence } : {}),
                }),
              );
              return;
            }
            if (evidence && evidence.mismatches.length > 0) {
              emit(
                fail("RUN_TAMPERED", `run ${target} evidence diverges: ${evidence.mismatches.length} artifact(s)`, {
                  run: target,
                  ...chain,
                  evidence,
                }),
              );
              return;
            }
            emit(ok({ run: target, verdict: "OK", ...chain, ...(evidence ? { evidence } : {}) }));
          } catch (e) {
            const gke = toGraphKitError(e, "RUN_ERROR");
            emit(fail(gke.code, gke.message, gke.details));
          }
          return;
        }
        if (subcommand === "analyze") {
          const target = Array.isArray(args) ? args[0] : args;
          try {
            emit(ok(analyzeRun(cwd, target == null || target === "" ? undefined : String(target))));
          } catch (e) {
            const gke = toGraphKitError(e, "RUN_ERROR");
            emit(fail(gke.code, gke.message, gke.details));
          }
          return;
        }
        emit(
          fail("UNKNOWN_RUN_SUBCOMMAND", `Unknown run subcommand "${subcommand}"`, {
            available: subcommandsFor("run").split(" "),
          }),
        );
      } catch (e) {
        const gke = toGraphKitError(e, "RUN_ERROR");
        emit(fail(gke.code, gke.message, gke.details));
      }
    });
}
