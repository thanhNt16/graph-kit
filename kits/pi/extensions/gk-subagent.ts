import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
}

export interface DispatchResult {
  ok: boolean;
  output: string;
  exit_code: number;
  /** true when the run was cut off by timeout_ms (or abort) — retry policies
   *  can match on this instead of scraping the output text. */
  timed_out?: boolean;
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
  if (constraints?.no_exec) argv.push("--tools", "Read,Glob,Grep");
  else if (constraints?.tools_allowlist?.length) argv.push("--tools", constraints.tools_allowlist.join(","));
  else if (constraints?.no_write) argv.push("--tools", "Read,Glob,Grep,Bash");
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
  const prompt = `${fragment}\n\n${buildPrompt(args)}`;
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
  const child = spawn(
    "/bin/sh",
    ["-c", 'printf %s "$GK_PROMPT" | exec omp "$@"', "gk-dispatch", ...buildPiArgs(args)],
    { env: { ...process.env, GK_PROMPT: prompt }, detached: true },
  );
  // Dispatch-intent record: written BEFORE spawn so a crashed coordinator
  // distinguishes "dispatched but quiet" from "never dispatched" on resume —
  // and so a racing child cannot observe a missing ledger line. Best-effort:
  // bookkeeping must never fail a dispatch. pid:null marks "about to launch".
  recordIntent(args, null);
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
    if (timedOut) {
      // "TIMEOUT" marker is contractual: retry.non_retryable entries and the
      // orchestrator match on it. exit_code 124 mirrors GNU timeout.
      resolve({
        ok: false,
        output: `${out}\nTIMEOUT: killed after ${timeout}ms (process group terminated)${suffix}`.trim(),
        exit_code: 124,
        timed_out: true,
      });
    } else if (code === 0) {
      resolve({ ok: true, output: `${out.trim()}${suffix}`, exit_code: 0 });
    } else {
      resolve({
        ok: false,
        output: `${out}\n${err}\nexit ${code ?? sig ?? "unknown"}${suffix}`.trim(),
        exit_code: typeof code === "number" ? code : 1,
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
      "Dispatch an isolated subagent run: loads .omp/agents/<agent>.md as the role prompt, appends objective/context, and runs a headless `omp -p` child process. Returns { ok, output, exit_code }. Honor wave barriers from gk-execute: treat ok:false as graph-stopping.",
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
