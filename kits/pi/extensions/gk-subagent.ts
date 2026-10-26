// The spawn contract here (dispatch/buildPiArgs/buildPrompt/recordIntent) is
// duplicated in graph-kit's src/exec/spawn.ts — the CANONICAL copy, consumed
// by the headless `gk exec` engine. This extension ships verbatim into target
// repos (.omp/extensions/) that have no graph-kit src/ to import, so the copy
// must stay self-contained; keep behavioral fixes in both files until the P3
// dedupe (kit-bridge bundling or generated shared file).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
   *  "append": fragment passed via --append-system-prompt. */
  role_prompt?: "append" | "inline";
  /** Emit `--mode json`; output is parsed and the raw stream is stored under
   *  the active run dir (events_path on the result). */
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

/** Minimal `omp -p --mode json` parser (mirrors src/factory/omp-events.ts —
 *  keep in sync). Tolerates unknown event types and non-JSON lines. */
export function parseOmpJsonStream(raw: string): {
  text: string;
  blocked: Array<{ tool: string; reason: string }>;
  aborted: boolean;
  event_types: string[];
} {
  const blocked: Array<{ tool: string; reason: string }> = [];
  const event_types = new Set<string>();
  let lastAssistantText = "";
  let lastAssistantAborted = false;
  const textOf = (m: { content?: Array<{ type?: string; text?: string }> } | undefined): string =>
    (m?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: {
      type?: string;
      toolName?: string;
      isError?: boolean;
      result?: { details?: { error?: string }; content?: Array<{ type?: string; text?: string }> };
      message?: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> };
      messages?: Array<{ role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o.type) event_types.add(o.type);
    if (o.type === "tool_execution_end" && o.isError) {
      blocked.push({
        tool: o.toolName ?? "unknown",
        reason: o.result?.details?.error ?? textOf(o.result) ?? "tool error",
      });
    }
    if (o.type === "message_end" && o.message?.role === "assistant") {
      lastAssistantText = textOf(o.message);
      lastAssistantAborted = o.message.stopReason === "aborted";
    }
    if (o.type === "agent_end") {
      const last = [...(o.messages ?? [])].reverse().find((m) => m.role === "assistant");
      if (last) {
        const txt = textOf(last);
        if (txt || lastAssistantText === "") {
          lastAssistantText = txt || lastAssistantText;
          lastAssistantAborted = last.stopReason === "aborted" || lastAssistantAborted;
        }
      }
    }
  }
  return { text: lastAssistantText, blocked, aborted: lastAssistantAborted, event_types: [...event_types] };
}

/** `.graphkit/runs/.active` → run dir, or null (same contract recordIntent
 *  reads). */
export function activeRunDir(cwd: string): string | null {
  try {
    const active = join(cwd, ".graphkit", "runs", ".active");
    if (!existsSync(active)) return null;
    return readFileSync(active, "utf-8").trim() || null;
  } catch {
    return null;
  }
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

/** Append one dispatch-intent line to the active run's dispatch.jsonl under
 *  <cwd>/.graphkit/runs/.active. Silent no-op when no run is active or the
 *  write fails — bookkeeping must never fail a dispatch. */
function recordIntent(args: DispatchArgs, pid: number | null): void {
  try {
    const active = join(args.cwd ?? process.cwd(), ".graphkit", "runs", ".active");
    if (!existsSync(active)) return;
    const dir = readFileSync(active, "utf-8").trim();
    appendFileSync(
      join(dir, "dispatch.jsonl"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        node: args.node ?? null,
        attempt: args.attempt ?? null,
        via: "extension",
        pid,
      })}\n`,
    );
  } catch {
    /* intent write is best-effort; never fail a dispatch over bookkeeping */
  }
}

export async function dispatch(args: DispatchArgs, signal?: AbortSignal): Promise<DispatchResult> {
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
    // mode_json: stdout is an event stream — persist it under the run dir and
    // extract the final assistant text + blocked-tool reasons.
    let eventsPath: string | undefined;
    let blocked: Array<{ tool: string; reason: string }> | undefined;
    let ompAborted = false;
    let display = out;
    if (args.mode_json) {
      try {
        const runDir = activeRunDir(args.cwd ?? process.cwd());
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

// Registration targets the pi extension API (registerTool + typebox schema),
// verified against badlogic/pi-mono packages/coding-agent/docs/extensions.md.
// The factory dynamically imports typebox so unit tests can import the pure
// dispatch functions above without any pi/typebox runtime present.
interface MinimalPiAPI {
  registerTool(tool: {
    name: string;
    label?: string;
    description?: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: DispatchArgs,
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
  }): void;
}

export default async function gkSubagentExtension(pi: MinimalPiAPI): Promise<void> {
  const { Type } = (await import("typebox")) as {
    Type: {
      Object: (props: Record<string, unknown>, opts?: unknown) => unknown;
      String: (opts?: unknown) => unknown;
      Boolean: (opts?: unknown) => unknown;
      Array: (schema: unknown, opts?: unknown) => unknown;
      Number: (opts?: unknown) => unknown;
      Optional: (schema: unknown, opts?: unknown) => unknown;
    };
  };

  pi.registerTool({
    name: "gk_dispatch_agent",
    label: "Dispatch Agent",
    description:
      "Dispatch an isolated subagent run: loads .omp/agents/<agent>.md as the role prompt, appends objective/context, and runs a headless `omp -p` child process. Returns { ok, output, exit_code }. The exec engine (src/exec/engine.ts) owns wave barriers and graph-stop rules; `gk exec --help` documents the headless path this tool backs.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent fragment name (file stem under .omp/agents/, e.g. data-engineer)" }),
      model: Type.Optional(Type.String({ description: "Model tier or ID passed to omp --model" })),
      objective: Type.String({ description: "What the subagent must accomplish" }),
      context: Type.Optional(Type.String({ description: "Upstream results, refs, or extra background" })),
      constraints: Type.Optional(
        Type.Object(
          {
            no_exec: Type.Optional(Type.Boolean({ description: "Restrict the child to read-only tools, no shell" })),
            no_write: Type.Optional(Type.Boolean({ description: "Restrict the child to read/bash tools" })),
            tools_allowlist: Type.Optional(
              Type.Array(Type.String(), { description: "Comma-joined into --tools for the child run" }),
            ),
          },
          { additionalProperties: false },
        ),
      ),
      // Ledger identity + run root for the dispatch-intent record; without
      // these the tool path logs node:null and resume reconciliation can't
      // distinguish "dispatched but quiet" from "never dispatched".
      node: Type.Optional(Type.String({ description: "Graph node id this dispatch belongs to" })),
      attempt: Type.Optional(Type.Number({ description: "Attempt number for this node (recorded in dispatch.jsonl)" })),
      cwd: Type.Optional(
        Type.String({ description: "Run root (defaults to process cwd); reads <cwd>/.graphkit/runs/.active" }),
      ),
      skills: Type.Optional(
        Type.Array(Type.String(), { description: "omp --skills list; pass [] to run with --no-skills" }),
      ),
      thinking: Type.Optional(Type.String({ description: "omp --thinking effort" })),
      max_time: Type.Optional(Type.String({ description: "omp --max-time duration (e.g. '45m')" })),
      extensions: Type.Optional(Type.Array(Type.String(), { description: "omp -e extension paths" })),
      mode_json: Type.Optional(Type.Boolean({ description: "Emit --mode json; output is parsed from the event stream" })),
      no_session: Type.Optional(Type.Boolean({ description: "Emit --no-session" })),
      approval_mode: Type.Optional(Type.String({ description: "omp --approval-mode (yolo|write)" })),
      role_prompt: Type.Optional(
        Type.String({ description: "'inline' (default) pipes the agent fragment via stdin; 'append' uses --append-system-prompt" }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description:
            "Kill budget in ms (default 600000). On timeout the whole child process group is terminated and the result is { ok:false, exit_code:124, timed_out:true } with a TIMEOUT marker in output.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await dispatch(params, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
