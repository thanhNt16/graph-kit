import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CAC } from "cac";
import { type PlanGraph, type PlannedNode, planGraph } from "../../compiler/plan.js";
import { isBlocking, validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import { runGraph } from "../../exec/engine.js";
import { type DispatchArgs, type DispatchConstraints, spawnDispatch } from "../../exec/spawn.js";
import type { DispatchContext, DispatchOutcome, InteractiveHooks, Runner, RunVerdict } from "../../exec/types.js";
import { listSessionGraphs } from "../../store/index.js";
import { toGraphKitError } from "../diagnostics.js";
import { type ResolvedGraph, resolveGraphPath } from "../graph-resolve.js";
import { materializeNodeAgents } from "../node-agents.js";
import { emit, fail, ok } from "../output.js";
import { loadGraph } from "./graph.js";

// `gk exec` — the headless runner: resolve the graph through the ONE P0
// resolver, plan it, and drive runGraph with the childProcess Runner
// (spawnDispatch per node). Non-JSON mode keeps stdout for the final verdict
// summary; every per-node progress line rides stderr so `--json` stdout stays
// a single envelope.
//
// Judge contract (binding, from the T3 engine review): the engine's default
// judgePredicate evaluates every predicate false, which under a judge-less
// exec silently skips `when:` nodes and burns `stop_when:` loops to
// max_rounds. This verb therefore FAILS FAST (JUDGE_REQUIRED) on any
// judge-dependent graph; `--no-judge` is the explicit acknowledgment that
// proceeds with those semantics after a stderr warning. An LLM JudgeFn is a
// future upgrade — the fail-fast default never guesses.
//
// Gates are hook-dependent, not judge-dependent: headless auto-skip is the
// engine's documented behavior (verdict "blocked", notes
// "gate-auto-skipped", exit 1 — never silent). `--yes` approves every gate.

const UPSTREAM_HEAD = 4000;
const CHALLENGE_RE = /^CHALLENGE:\s*(\S+)\s+—\s*(.+)$/u;

// ---------------------------------------------------------------------------
// Graph classification

/** Nodes the false-judge would mis-execute: `when:` predicates and enabled
 *  node-local loops with `stop_when`. Graph-level `loops[]` groups are NOT
 *  covered here — the planner drops them entirely, so the verb refuses them
 *  outright (UNSUPPORTED_LOOPS) instead of classifying; no `stop_while`
 *  field exists in this schema. */
export function judgeDependence(plan: PlanGraph): Array<{ node: string; field: string }> {
  const out: Array<{ node: string; field: string }> = [];
  for (const w of plan.waves) {
    for (const n of w.nodes) {
      if (n.when != null) out.push({ node: n.id, field: "when" });
      if (n.loop?.enabled === true && n.loop.stop_when != null) out.push({ node: n.id, field: "loop.stop_when" });
    }
  }
  return out;
}

/** Write-capable = the node's constraints don't revoke write/exec tools —
 *  the same flags node-agents.ts maps to restricted toolsets. Explicit
 *  tools_allowlists are not inspected: they narrow omp tools, not intent. */
export function isWriteCapable(node: PlannedNode): boolean {
  return !node.constraints.some((c) => c.no_write === true || c.no_exec === true);
}

// ---------------------------------------------------------------------------
// The childProcess Runner

function dispatchConstraints(node: PlannedNode): DispatchConstraints | undefined {
  const out: DispatchConstraints = {};
  let allow: string[] | null = null;
  for (const c of node.constraints) {
    for (const [k, v] of Object.entries(c)) {
      if ((k === "no_exec" || k === "no_write") && v === true) out[k] = true;
      if (k === "tools_allowlist" && (typeof v === "string" || Array.isArray(v))) {
        const list = (typeof v === "string" ? v.split(",") : v).map((t) => t.trim()).filter(Boolean);
        allow = allow === null ? list : allow.filter((t) => list.includes(t));
      }
    }
  }
  if (allow !== null) out.tools_allowlist = allow;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Head per upstream node in the dispatch context — the prompt travels in an
 *  env var, so unbounded upstream output would break execve (ponytail: the
 *  engine's budget_tokens spill is the upgrade path for large contexts). */
function upstreamContext(ctx: DispatchContext): string {
  return [...ctx.upstream.values()]
    .filter((r) => r.outcome != null)
    .map((r) => {
      const out = (r.outcome?.output ?? "").trim();
      return `## ${r.id} — ${r.status}\n${out.slice(0, UPSTREAM_HEAD)}${out.length > UPSTREAM_HEAD ? "…" : ""}`;
    })
    .join("\n\n");
}

/** Headless dispatch: the engine's DispatchContext over spawnDispatch. The
 *  agent fragment (materialized gk-<id>) and the ledger live at the repo
 *  root (`cwd`); `child_cwd` moves the agent process into its worktree. */
export class SpawnRunner implements Runner {
  constructor(
    private agents: Record<string, string>,
    private worktrees?: ReadonlyMap<string, string>,
  ) {}

  dispatch(node: PlannedNode, ctx: DispatchContext): Promise<DispatchOutcome> {
    const args: DispatchArgs = {
      agent: this.agents[node.id] ?? node.agent,
      model: node.model ?? undefined,
      objective: node.objective,
      context: upstreamContext(ctx) || undefined,
      constraints: dispatchConstraints(node),
      timeout_ms: node.timeout_ms ?? undefined,
      node: node.id,
      attempt: ctx.attempt,
      cwd: ctx.cwd,
      child_cwd: this.worktrees?.get(node.id),
    };
    return spawnDispatch(args);
  }
}

// ---------------------------------------------------------------------------
// Worktree mode — merge-on-land (kits/_core/skills/gk-execute SKILL.md)

const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function assertGitRepo(cwd: string): void {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    throw new GraphKitError(
      "WORKTREE_UNAVAILABLE",
      `WORKTREE_UNAVAILABLE: --worktree needs a git repository (no repo at ${cwd})`,
      { cwd },
    );
  }
}

interface WaveRec {
  node: PlannedNode;
  write: boolean;
  outcome?: DispatchOutcome;
}

/**
 * Wraps the inner Runner with the worktree protocol: every write-capable
 * node of a wave dispatches inside `.graphkit/worktrees/<id>` on branch
 * `gk/<id>`; once a wave's dispatches all drain, branches merge sequentially
 * into the main tree (node order). A conflict aborts the merge, rewrites the
 * node's outcome to fail (the engine's hard barrier then stops the graph),
 * and no further branch merges — the skill's never-hand-resolve-mid-run rule.
 *
 * Dispatch promises hold until the wave settles so merge results can rewrite
 * outcomes before the engine records them. Waves merge only when every write
 * node finished ok with no CHALLENGE line (a deferred finding must not land).
 *
 * ponytail: fan_out briefs and advisors dispatch under modified node ids, so
 * they run unisolated at the repo root; per-brief worktrees need plan-aware
 * fan isolation nobody has asked for yet.
 */
export class WorktreeRunner implements Runner {
  private current: {
    wave: PlanGraph["waves"][number];
    outcomes: Map<string, DispatchOutcome>;
    merged: Set<string>;
  } | null = null;
  private batch: WaveRec[] = [];
  /** node id → worktree path. Shared with the inner Runner (SpawnRunner reads
   *  it per dispatch as the child's cwd) and with tests/observers. */
  readonly created: Map<string, string>;

  constructor(
    private inner: Runner,
    private root: string,
    private plan: PlanGraph,
    private note: (msg: string) => void = () => {},
    paths: Map<string, string> = new Map(),
  ) {
    this.created = paths;
  }

  onWaveStart(wave: PlanGraph["waves"][number]): void {
    this.current = { wave, outcomes: new Map(), merged: new Set() };
  }

  dispatch(node: PlannedNode, ctx: DispatchContext): Promise<DispatchOutcome> {
    const planned = this.current?.wave.nodes.some((n) => n.id === node.id) ?? false;
    const write = planned && isWriteCapable(node);
    if (write) this.ensureWorktree(node.id);
    const rec: WaveRec = { node, write, outcome: undefined };
    this.batch.push(rec);
    void this.inner
      .dispatch(node, ctx)
      .then((o) => {
        rec.outcome = o;
        if (write) this.current?.outcomes.set(node.id, o);
        this.settle();
      })
      .catch((e: unknown) => {
        rec.outcome = {
          ok: false,
          output: e instanceof Error ? e.message : String(e),
          exitCode: -1,
          durationMs: 0,
        };
        if (write) this.current?.outcomes.set(node.id, rec.outcome);
        this.settle();
      });
    return new Promise<DispatchOutcome>((resolve) => {
      rec.resolve = resolve;
    });
  }

  private ensureWorktree(id: string): void {
    if (this.created.has(id)) return;
    const path = join(this.root, ".graphkit", "worktrees", id);
    try {
      execFileSync("git", ["worktree", "add", path, "-b", `gk/${id}`], {
        cwd: this.root,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const detail = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? String(e);
      throw new GraphKitError(
        "WORKTREE_CREATE_FAILED",
        `WORKTREE_CREATE_FAILED: git worktree add ${path} -b gk/${id}\n${detail}\n` +
          `leftovers from an earlier run? \`git worktree remove ${path}\` and \`git branch -D gk/${id}\``,
        { node: id, path, branch: `gk/${id}` },
      );
    }
    this.created.set(id, path);
    this.note(`[exec] worktree ${id} → ${path} (branch gk/${id})`);
  }

  /** Last drain of a batch settles the wave: merge what qualifies, then
   *  release the held dispatch promises (with rewritten outcomes). */
  private settle(): void {
    if (this.batch.length === 0 || this.batch.some((r) => r.outcome === undefined)) return;
    const batch = this.batch;
    this.batch = [];
    try {
      this.mergeWave(batch);
    } catch (e) {
      this.note(`[exec] worktree merge error: ${(e as Error).message}`);
    }
    for (const rec of batch) rec.resolve?.(rec.outcome!);
  }

  private mergeWave(batch: WaveRec[]): void {
    const cur = this.current;
    if (!cur) return;
    const writes = cur.wave.nodes.filter((n) => isWriteCapable(n));
    if (writes.length === 0) return;
    // A wave lands only when every write node finished clean — no failed
    // rounds, no deferred CHALLENGE findings (the skill: a wave is done when
    // merged, and a challenge defers the verdict to the host).
    const ready = writes.every((n) => {
      const o = cur.outcomes.get(n.id);
      return o != null && o.ok && !CHALLENGE_RE.test(o.output.trim().split("\n").filter(Boolean).pop() ?? "");
    });
    if (!ready) return;
    for (const n of writes) {
      if (cur.merged.has(n.id)) continue;
      const branch = `gk/${n.id}`;
      // Landing insurance: commit whatever the agent left dirty in its
      // worktree (the dispatch brief instructs agents to commit; this is the
      // belt to those braces).
      const wt = this.created.get(n.id);
      if (wt) {
        try {
          git(["add", "-A"], wt);
          if (git(["status", "--porcelain"], wt).trim().length > 0)
            git(["commit", "-q", "-m", `gk(${n.id}): land node work`], wt);
        } catch (e) {
          this.note(`[exec] node ${n.id}: worktree commit failed — ${branch} not merged (${(e as Error).message})`);
          continue;
        }
      }
      try {
        git(["merge", "--no-commit", "--no-ff", branch], this.root);
        // "Already up to date" exits 0 with no MERGE_HEAD (the branch is an
        // ancestor — zero commits landed): a no-op merge, not a conflict.
        let sealed = false;
        try {
          execFileSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
            cwd: this.root,
            stdio: ["ignore", "ignore", "ignore"],
          });
          sealed = true;
        } catch {
          /* no MERGE_HEAD — nothing to seal */
        }
        if (sealed) git(["commit", "-q", "--no-edit"], this.root);
        cur.merged.add(n.id);
        this.note(
          `[exec] merged ${branch} into ${git(["rev-parse", "--abbrev-ref", "HEAD"], this.root).trim()}` +
            (sealed ? "" : " (no commits — already up to date)"),
        );
      } catch (e) {
        const detail = (e as { stderr?: Buffer }).stderr?.toString() ?? "";
        const files = [...detail.matchAll(/CONFLICT \(content\): Merge conflict in (\S+)/gu)].map((m) => m[1]!);
        try {
          execFileSync("git", ["merge", "--abort"], { cwd: this.root, stdio: ["ignore", "ignore", "ignore"] });
        } catch {
          /* no merge in progress — nothing to abort */
        }
        const outcome: DispatchOutcome = {
          ok: false,
          output: `merge-conflict:${branch}${files.length > 0 ? ` (${files.join(", ")})` : ""}`,
          exitCode: 1,
          durationMs: cur.outcomes.get(n.id)?.durationMs ?? 0,
        };
        this.note(`[exec] merge conflict on ${branch}${files.length > 0 ? `: ${files.join(", ")}` : ""} — graph stops`);
        const rec = batch.find((r) => r.node.id === n.id);
        if (rec) {
          rec.outcome = outcome;
        } else if (batch.length > 0) {
          // Cross-batch conflict (the conflicted node's promise was already
          // consumed by an earlier settle): fail a live-batch record instead
          // so the engine's barrier stops the graph with the real error
          // rather than landing an unmerged-ok node.
          // ponytail: promise rewriting wants a runner-level settle queue;
          // revisit if this branch ever fires in practice.
          this.note(`[exec] ${branch} conflicted post-settle — failing the wave batch to stop the graph`);
          const other = batch.find((r) => r.outcome != null);
          if (other) {
            other.outcome = { ...outcome, output: `${outcome.output} (wave aborted: ${branch} conflicted)` };
            cur.outcomes.set(other.node.id, other.outcome);
          }
        }
        cur.outcomes.set(n.id, outcome);
        return; // never start the next merge after a conflict
      }
    }
  }

  /** Post-run housekeeping per the skill: on a merged verdict remove the
   *  worktree checkouts (branches stay for PRs); otherwise keep them for
   *  debugging and say where. */
  finalize(verdict: RunVerdict): void {
    if (this.created.size === 0) return;
    if (verdict.status === "merged") {
      for (const [id, path] of this.created) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", path], {
            cwd: this.root,
            stdio: ["ignore", "ignore", "ignore"],
          });
        } catch (e) {
          this.note(`[exec] worktree ${id} cleanup failed: ${(e as Error).message}`);
        }
      }
      try {
        rmSync(join(this.root, ".graphkit", "worktrees"), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    } else {
      this.note(`[exec] ${verdict.status}: worktrees kept for inspection — ${[...this.created.values()].join(", ")}`);
    }
    this.note(`[exec] branches kept: ${[...this.created.keys()].map((id) => `gk/${id}`).join(", ")}`);
  }
}

/** One engine dispatch this runner holds open until the wave settles. */
interface WaveRec {
  node: PlannedNode;
  write: boolean;
  outcome?: DispatchOutcome;
  resolve?: (o: DispatchOutcome) => void;
}

// ---------------------------------------------------------------------------
// Graph resolution: positional arg XOR --session XOR --graph, else the P0
// resolver's run → active → root precedence.

function sessionGraphPath(cwd: string, id: string): string {
  const sessions = existsSync(join(cwd, ".graphkit")) ? listSessionGraphs(cwd) : [];
  const hit = sessions.find((g) => g.id === id);
  if (!hit)
    throw new GraphKitError(
      "SESSION_NOT_FOUND",
      `SESSION_NOT_FOUND: no session graph "${id}" (${sessions.map((g) => g.id).join(", ") || "none"})`,
      { id, available: sessions.map((g) => g.id) },
    );
  return hit.path;
}

function resolveExecGraph(
  cwd: string,
  positional: string | undefined,
  graph: unknown,
  session: unknown,
): ResolvedGraph {
  const graphFlag = typeof graph === "string" && graph.length > 0 ? graph : undefined;
  const sessionFlag = typeof session === "string" && session.length > 0 ? session : undefined;
  if (positional && (graphFlag || sessionFlag))
    throw new GraphKitError("CLI_FLAG_CONFLICT", "pass the graph as a positional arg OR --graph/--session, not both");
  if (graphFlag && sessionFlag)
    throw new GraphKitError("CLI_FLAG_CONFLICT", "--graph and --session are mutually exclusive");
  if (positional) return resolveGraphPath(cwd, positional);
  if (sessionFlag) return { path: sessionGraphPath(cwd, sessionFlag), source: "flag" };
  if (graphFlag) return resolveGraphPath(cwd, graphFlag);
  return resolveGraphPath(cwd);
}

// ---------------------------------------------------------------------------
// The verb

export interface ExecDeps {
  /** Test seam: override the child-process Runner. */
  runner?: Runner;
  /** Shared worktree path map (SpawnRunner reads it; tests observe it). */
  worktrees?: Map<string, string>;
}

export function registerExecCommand(cli: CAC, deps: ExecDeps = {}): { settle: () => Promise<unknown[]> } {
  // cac does not await async command actions; track each invocation so test
  // harnesses can await `settle()` instead of sleeping.
  const pending: Promise<unknown>[] = [];
  cli
    .command("exec [graph]", "Headless graph runner — resolve, plan, and execute every node via child-process dispatch")
    .option("--graph <id|path>", "graph file path or session graph id (defaults: active run → session → ./graph.yaml)")
    .option("--session <id>", "session graph id (store lookup only)")
    .option("--json", "emit the RunVerdict envelope on stdout (progress stays on stderr)")
    .option("--yes", "approve every gate node (headless gate approval)")
    .option(
      "--no-judge",
      "acknowledge judge-dependent fields run unevaluated: when: nodes skip, stop_when: loops run to max_rounds",
    )
    .option(
      "--worktree",
      "isolate write-capable nodes in git worktrees (.graphkit/worktrees/<id>, branch gk/<id>) with merge-on-land",
    )
    .example("gk exec graph.yaml --json")
    .example("gk exec --session 2026-10-07-my-graph --worktree")
    .action(async (positional, opts) => {
      const run = async () => {
        const cwd = process.cwd();
        const err = (msg: string) => console.error(msg);
        try {
          const resolved = resolveExecGraph(
            cwd,
            positional == null ? undefined : String(positional),
            opts.graph,
            opts.session,
          );
          const graph = loadGraph(resolved.path);
          const findings = validateGraph(graph, cwd);
          if (findings.some(isBlocking)) {
            emit(fail("VALIDATION_FAILED", "graph has findings", { issues: findings }));
            return;
          }
          // Graph-level `loops[]` groups are schema-valid but unplanned:
          // planGraph maps node-local `loop` only, so a loop-group graph
          // would execute one silent pass and report merged. Refuse before
          // any dispatch until the engine executes groups.
          if (graph.loops !== undefined && graph.loops.length > 0) {
            emit(
              fail(
                "UNSUPPORTED_LOOPS",
                `graph declares ${graph.loops.length} top-level \`loops:\` group(s) — gk exec executes ` +
                  "node-local `loop:` only; loop groups would silently run a single pass. " +
                  "Move `stop_when` onto the individual nodes' `loop:` (or drive the run via the gk-execute skill).",
                { groups: graph.loops.length },
              ),
            );
            return;
          }
          const agents = materializeNodeAgents(cwd, graph);
          const plan = planGraph(graph);

          // Judge contract: never silently run a judge-dependent graph on the
          // false-judge. Fail fast, or proceed only under --no-judge.
          const judged = judgeDependence(plan);
          // cac maps a declared `--no-judge` to `judge: false`; absent → undefined.
          if (judged.length > 0 && opts.judge !== false) {
            emit(
              fail(
                "JUDGE_REQUIRED",
                `graph declares judge-dependent fields (${judged.map((j) => `${j.node}:${j.field}`).join(", ")}) ` +
                  "and `gk exec` has no judge — predicates would all evaluate false, skipping when: nodes and " +
                  "running stop_when: loops to max_rounds. Re-run with --no-judge to accept those semantics.",
                { judged },
              ),
            );
            return;
          }
          if (judged.length > 0)
            err(
              `[exec] WARNING --no-judge: judge-dependent fields unevaluated (${judged
                .map((j) => `${j.node}:${j.field}`)
                .join(", ")}) — when: nodes will skip, stop_when: loops run to max_rounds`,
            );

          // The shared worktree map must exist BEFORE SpawnRunner captures
          // it: the Runner holds the map identity from construction (a later
          // deps reassignment would never be re-read), so the --worktree
          // block below populates this same instance per dispatch.
          const shared = deps.worktrees ?? new Map<string, string>();
          let runner: Runner = deps.runner ?? new SpawnRunner(agents, shared);
          let worktrees: WorktreeRunner | null = null;
          if (opts.worktree) {
            assertGitRepo(cwd);
            worktrees = new WorktreeRunner(runner, cwd, plan, err, shared);
            runner = worktrees;
          }

          const interactive: InteractiveHooks = {
            onWaveStart: (w) => {
              worktrees?.onWaveStart(w);
              err(`[exec] wave ${w.index}: ${w.nodes.length} node(s)`);
            },
            onNodeResult: (n) =>
              err(
                `[exec] ${n.id}: ${n.status}${n.attempts > 1 ? ` (attempt ${n.attempts})` : ""}${
                  n.outcome ? ` [${n.outcome.exitCode}] ${n.outcome.durationMs}ms` : ""
                }`,
              ),
            ...(opts.yes ? { askGate: async () => true } : {}),
          };

          const verdict = await runGraph(plan, { cwd, runner, graph, graphPath: resolved.path, interactive });
          worktrees?.finalize(verdict);

          if (opts.json) {
            emit(ok(verdict));
          } else {
            const by = (s: string) => verdict.nodes.filter((n) => n.status === s).length;
            console.log(`gk exec → ${verdict.status}`);
            console.log(`run ${verdict.runId} · graph ${resolved.path} (${resolved.source})`);
            console.log(
              `nodes ${verdict.nodes.length} — ok ${by("ok") + by("landed")}, fail ${by("fail")}, skipped ${by("skipped")}, challenge ${by("challenge")}`,
            );
            for (const n of verdict.nodes) console.log(`  ${n.id}  ${n.status}`);
            console.log(`trace: .graphkit/runs/${verdict.runId}/trace.jsonl`);
            if (verdict.unresolved.length > 0) console.log(`unresolved dispatches: ${verdict.unresolved.join(", ")}`);
          }
          if (verdict.status !== "merged") process.exitCode = 1;
        } catch (e) {
          const gke = toGraphKitError(e, "EXEC_ERROR");
          emit(fail(gke.code, gke.message, gke.details));
        }
      };
      const p = run();
      pending.push(p);
      return p;
    });
  return { settle: () => Promise.all(pending) };
}
