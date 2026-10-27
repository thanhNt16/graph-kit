// Headless child-process dispatch — the childProcess Runner's core. Ported
// from kits/_core/extensions/gk-subagent.ts, which keeps a standalone verbatim
// copy: extensions materialize verbatim into target repos (gen-kits.ts /
// sync-omp.ts) where no graph-kit src/ exists to import. This module is
// canonical for `gk exec`; keep behavioral fixes in both until the P3 dedupe.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseOmpJsonStream } from "../factory/omp-events.js";
import { activeRun, appendDispatch } from "../runs/ledger.js";
import type { DispatchOutcome } from "./types.js";

export interface DispatchConstraints {
  no_exec?: boolean;
  no_write?: boolean;
  tools_allowlist?: string[];
}

export interface DispatchArgs {
  agent: string;
  model?: string;
  objective: string;
  context?: string;
  constraints?: DispatchConstraints;
  timeout_ms?: number;
  /** Ledger identity for the dispatch-intent record (node/attempt) and the
   *  run root to write it under; defaults to process.cwd(). */
  node?: string;
  attempt?: number | null;
  cwd?: string;
  /** Working directory for the spawned child itself (worktree isolation).
   *  Agent-fragment loading and ledger writes stay on `cwd` — the repo root —
   *  while the agent process runs here. Unset → child inherits the caller's cwd. */
  child_cwd?: string;
  /** omp `--skills` list; `[]` emits `--no-skills`. Unset → omp discovers. */
  skills?: string[];
  thinking?: string;
  /** omp `--max-time` duration (e.g. "45m"). Distinct from timeout_ms, which
   *  is gk's own process kill budget — max_time makes omp abort its turn. */
  max_time?: string;
  /** omp `-e` extension paths (order preserved). */
  extensions?: string[];
  /** "inline" (default): agent fragment + objective piped via stdin.
   *  "append": fragment passed via --append-system-prompt, stdin gets the
   *  objective/context only — keeps role prose out of the user turn. */
  role_prompt?: "append" | "inline";
  /** Emit `--mode json`; output is parsed via parseOmpJsonStream and the raw
   *  stream is stored under the active run dir (events_path on the result). */
  mode_json?: boolean;
  /** Full environment for the child, replacing process.env (GK_PROMPT is
   *  still injected). Use for factory credential scrubbing; unset inherits. */
  env?: Record<string, string>;
  approval_mode?: "yolo" | "write";
  no_session?: boolean;
}

export interface DispatchResult {
  ok: boolean;
  output: string;
  exit_code: number;
  /** true when the run was cut off by timeout_ms (or abort) — retry policies
   *  can match on this instead of scraping the output text. */
  timed_out?: boolean;
  /** mode_json: path of the raw event stream under the run dir. */
  events_path?: string;
  /** mode_json: tool calls that ended as errors (extension-blocked, not
   *  found, runtime failure). */
  blocked?: Array<{ tool: string; reason: string }>;
}

export function loadAgentPrompt(agent: string, cwd = process.cwd()): string | null {
  const p = join(cwd, ".omp", "agents", `${agent}.md`);
  if (!existsSync(p)) return null;
  // Kit agents carry omp task-discovery frontmatter (name/description);
  // strip it — the dispatch prompt is prose, not YAML.
  return readFileSync(p, "utf8").replace(/^---\n[\s\S]*?\n---\n*/, "");
}

export function buildPiArgs(args: DispatchArgs): string[] {
  const argv = ["-p", ...(args.model ? ["--model", args.model] : [])];
  const constraints = args.constraints;
  // Exclusive precedence: no_exec removes the shell entirely; an explicit
  // allowlist beats the no_write default; no_write keeps Bash (best-effort).
  // omp tool names are lowercase (tools/builtin-names.ts).
  if (constraints?.no_exec) argv.push("--tools", "read,glob,grep");
  else if (constraints?.tools_allowlist?.length) argv.push("--tools", constraints.tools_allowlist.join(","));
  else if (constraints?.no_write) argv.push("--tools", "read,glob,grep,bash");
  if (args.skills !== undefined) {
    if (args.skills.length === 0) argv.push("--no-skills");
    else argv.push("--skills", args.skills.join(","));
  }
  if (args.thinking) argv.push("--thinking", args.thinking);
  if (args.max_time) argv.push("--max-time", args.max_time);
  for (const ext of args.extensions ?? []) argv.push("-e", ext);
  if (args.mode_json) argv.push("--mode", "json");
  if (args.approval_mode) argv.push("--approval-mode", args.approval_mode);
  if (args.no_session) argv.push("--no-session");
  return argv;
}

export function buildPrompt(args: DispatchArgs): string {
  return [`## Objective\n${args.objective}`, args.context ? `## Context\n${args.context}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

/** Append one dispatch-intent line to the active run's dispatch.jsonl via the
 *  run ledger (same DispatchLine format `gk run dispatch` writes). Silent
 *  no-op when no run is active or the write fails — bookkeeping must never
 *  fail a dispatch. The ledger's DispatchLine.node is a string; an unbound
 *  dispatch records "" (never matches a node id on resume, same as null). */
function recordIntent(args: DispatchArgs, pid: number | null): void {
  try {
    const cwd = args.cwd ?? process.cwd();
    if (!activeRun(cwd)) return;
    appendDispatch(cwd, {
      node: args.node ?? "",
      attempt: args.attempt ?? null,
      via: "extension",
      pid,
    });
  } catch {
    /* intent write is best-effort; never fail a dispatch over bookkeeping */
  }
}

async function dispatch(args: DispatchArgs, signal?: AbortSignal): Promise<DispatchResult> {
  const fragment = loadAgentPrompt(args.agent, args.cwd);
  if (!fragment) return { ok: false, output: `Unknown agent: ${args.agent}`, exit_code: 1 };
  // "append" mode moves the role fragment to --append-system-prompt so the
  // stdin turn carries only objective/context (factory role prompts).
  const appendFragment = args.role_prompt === "append";
  const prompt = appendFragment ? buildPrompt(args) : `${fragment}\n\n${buildPrompt(args)}`;
  const piArgs = buildPiArgs(args);
  if (appendFragment) piArgs.push("--append-system-prompt", fragment);
  const timeout = args.timeout_ms ?? 600_000;
  const { promise, resolve } = Promise.withResolvers<DispatchResult>();
  // omp -p reads the prompt from piped stdin. Prompt-as-argv and direct
  // stdin pipes both stall omp at readPipedInput (EOF never observed);
  // a shell pipeline closes the pipe reliably and stays async/parallel.
  //
  // detached: the child becomes a process-group leader so timeout/abort kills
  // the WHOLE tree (omp + any subprocesses it spawned). Plain execFile only
  // SIGTERMs the direct child — observed in the wild: a timed-out builder kept
  // writing to a shared DB for 11+ minutes after the orchestrator recorded it
  // failed, racing its own resume dispatch.
  //
  // Dispatch-intent record: written BEFORE spawn() is invoked — with detached
  // posix_spawn the child can already be executing by the time spawn()
  // returns, so a write after the call races the child's own startup checks
  // (observed on Linux CI). pid:null marks "about to launch"; best-effort,
  // bookkeeping never fails a dispatch.
  // Intent multiplicity is deliberate (audit #6, won't-fix): the orchestrator's
  // `gk run dispatch --via extension` + this pre-spawn pid:null + the post-spawn
  // real-pid line give resume/take three monotonic states — declared, launching,
  // live. Deduping would add read-before-write to a path that must never fail.
  recordIntent(args, null);
  const child = spawn(
    "/bin/sh",
    ["-c", `printf %s "$GK_PROMPT" | exec ${process.env.GK_OMP_BIN ?? "omp"} "$@"`, "gk-dispatch", ...piArgs],
    // Child cwd: the worktree when isolated, else the ledger/agent root —
    // never the orchestrator's process.cwd(), which under `gk exec` may be
    // any directory the user invoked from.
    {
      env: { ...(args.env ?? process.env), GK_PROMPT: prompt },
      detached: true,
      cwd: args.child_cwd ?? args.cwd,
    },
  );
  // The 'spawn' event fires once the OS accepts the fork — record the real
  // pid as a second ledger line so `gk run take` can kill live dispatches.
  child.once("spawn", () => recordIntent(args, child.pid ?? null));
  const MAX_OUTPUT = 10 * 1024 * 1024;
  let out = "";
  let err = "";
  let truncated = false;
  const collect = (chunk: Buffer, into: "out" | "err") => {
    const cur = into === "out" ? out : err;
    if (cur.length >= MAX_OUTPUT) {
      truncated = true;
      return;
    }
    const next = cur + chunk.toString("utf8");
    if (next.length > MAX_OUTPUT) truncated = true;
    if (into === "out") out = next.slice(0, MAX_OUTPUT);
    else err = next.slice(0, MAX_OUTPUT);
  };
  child.stdout?.on("data", (c: Buffer) => collect(c, "out"));
  child.stderr?.on("data", (c: Buffer) => collect(c, "err"));

  let timedOut = false;
  let settled = false;
  const killGroup = (sig: NodeJS.Signals) => {
    try {
      // Negative pid = the child's whole process group (detached leader).
      process.kill(-child.pid!, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  const escalate = () => {
    // SIGTERM first; if the tree is still alive after the grace window,
    // SIGKILL the group. A graceful shutdown that outlives the grace window
    // would otherwise keep mutating shared state after we reported failure.
    killGroup("SIGTERM");
    const t = setTimeout(() => killGroup("SIGKILL"), 5_000);
    t.unref?.();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    escalate();
  }, timeout);
  const onAbort = () => {
    timedOut = true;
    escalate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  child.on("error", (e) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    resolve({ ok: false, output: String(e.message ?? e), exit_code: 1 });
  });
  child.on("close", (code, sig) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    const suffix = truncated ? "\n[output truncated at 10MB]" : "";
    // mode_json: stdout is an event stream, not prose — persist it under the
    // run dir and extract the final assistant text + blocked-tool reasons.
    let eventsPath: string | undefined;
    let blocked: Array<{ tool: string; reason: string }> | undefined;
    let ompAborted = false;
    let display = out;
    if (args.mode_json) {
      try {
        const runDir = activeRun(args.cwd ?? process.cwd());
        if (runDir) {
          const evDir = join(runDir, "omp-events");
          mkdirSync(evDir, { recursive: true });
          eventsPath = join(evDir, `${args.node ?? "dispatch"}-a${args.attempt ?? 0}.jsonl`);
          writeFileSync(eventsPath, out);
        }
      } catch {
        /* event persistence is best-effort */
      }
      const parsed = parseOmpJsonStream(out);
      blocked = parsed.blocked.length > 0 ? parsed.blocked : undefined;
      display = parsed.text || out;
      // omp --max-time ends the turn with stopReason "aborted" + exit 1 —
      // surface it as timed_out (not gk's own kill, so no TIMEOUT marker).
      ompAborted = parsed.aborted;
    }
    if (timedOut) {
      // "TIMEOUT" marker is contractual: retry.non_retryable entries and the
      // orchestrator match on it. exit_code 124 mirrors GNU timeout.
      resolve({
        ok: false,
        output: `${display}\nTIMEOUT: killed after ${timeout}ms (process group terminated)${suffix}`.trim(),
        exit_code: 124,
        timed_out: true,
        ...(eventsPath ? { events_path: eventsPath } : {}),
        ...(blocked ? { blocked } : {}),
      });
    } else if (code === 0) {
      resolve({
        ok: true,
        output: `${display.trim()}${suffix}`,
        exit_code: 0,
        ...(eventsPath ? { events_path: eventsPath } : {}),
        ...(blocked ? { blocked } : {}),
      });
    } else {
      resolve({
        ok: false,
        output: `${display}\n${err}\nexit ${code ?? sig ?? "unknown"}${suffix}`.trim(),
        exit_code: typeof code === "number" ? code : 1,
        ...(eventsPath ? { events_path: eventsPath } : {}),
        ...(blocked ? { blocked } : {}),
        ...(ompAborted ? { timed_out: true } : {}),
      });
    }
  });
  return promise;
}

/** The Runner-facing dispatch: the engine's DispatchOutcome contract
 *  (camelCase + durationMs) over the raw child-process result. */
export async function spawnDispatch(args: DispatchArgs, signal?: AbortSignal): Promise<DispatchOutcome> {
  const started = Date.now();
  const r = await dispatch(args, signal);
  return {
    ok: r.ok,
    output: r.output,
    exitCode: r.exit_code,
    durationMs: Date.now() - started,
    ...(r.timed_out === undefined ? {} : { timedOut: r.timed_out }),
    ...(r.events_path === undefined ? {} : { eventsPath: r.events_path }),
    ...(r.blocked === undefined ? {} : { blocked: r.blocked }),
  };
}
