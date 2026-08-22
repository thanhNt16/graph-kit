import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface CbmClient {
  call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export interface CbmClientOpts {
  cmd?: string;
  args?: string[];
  cwd?: string;
}

// F3: the CBM package is unpublished (npm 404) and we deliberately do NOT
// resurrect the bridge — it can't work. When the child dies before a call
// resolves we surface one honest, actionable return contract instead.
export const CBM_UNAVAILABLE_MSG = `CBM bridge unavailable: @graphkit/codebase-memory-mcp is not published (npm 404). Point CBM_CMD / CBM_ARGS at a local codebase-memory-mcp build, or skip graph index|search|ask|trace|query and memory index.`;

export function createCbmClient(opts?: CbmClientOpts): CbmClient {
  const cmd = opts?.cmd ?? process.env.CBM_CMD ?? "npx";
  const args =
    opts?.args ?? (process.env.CBM_ARGS ? process.env.CBM_ARGS.split(" ") : ["-y", "@graphkit/codebase-memory-mcp"]);
  const cwd = opts?.cwd;

  const child = spawn(cmd, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let idCounter = 0;
  let fatal: Error | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  // Buffer stderr (instead of draining) so the tail is included in the
  // CBM_UNAVAILABLE message — the user sees WHY the bridge died.
  let stderrBuf = "";
  let started = false;

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    started = true; // bridge spoke — it's alive; stop buffering stderr tail
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result);
        }
      }
    } catch {}
  });

  child.stderr?.on("data", (d: Buffer) => {
    // started = we already saw handshake/first stdout line; only include the
    // tail, and only surface it once the failure is confirmed.
    if (!started) stderrBuf = (stderrBuf + d.toString()).slice(-4000);
  });

  // Child failed to spawn (e.g. npx ENOENT / npm 404) — fail every pending call.
  child.on("error", (err) => {
    fatal = new Error(`${CBM_UNAVAILABLE_MSG}\nspawn ${cmd} failed: ${err.message}`);
    rejectAll(fatal);
  });

  // Child exited before any call resolved — the bridge couldn't come up.
  // Set fatal even with zero pending: a LATER call would otherwise write to a
  // corpse and hang (stdin callback never errs), the same silent-exit class.
  child.on("exit", (_code, _signal) => {
    if (!fatal) {
      const withoutDetail = started ? `\n${cmd} exited unexpectedly.` : `\n${cmd} exited before handshake.`;
      const detail = stderrBuf.trim() !== "" ? `\nstderr tail: ${stderrBuf.trim()}` : withoutDetail;
      fatal = new Error(`${CBM_UNAVAILABLE_MSG}${detail}`);
    }
    if (fatal) rejectAll(fatal);
    rl.close();
  });

  function rejectAll(err: Error) {
    for (const entry of pending.values()) {
      entry.reject(err);
    }
    pending.clear();
  }

  function call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
    if (fatal) return Promise.reject(fatal); // bridge already dead — honest fail, don't write to a corpse
    const id = ++idCounter;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const msg = `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: tool, arguments: args },
      })}\n`;
      child.stdin!.write(msg, (err) => {
        if (err) {
          pending.delete(id);
          reject(new Error(`${CBM_UNAVAILABLE_MSG}\nstdin write failed: ${err.message}`));
        }
      });
    });
  }

  function close(): Promise<void> {
    // Already-dead child: the exit event fired before we could attach a
    // listener (and an unref'd timer won't hold the loop), so awaiting the
    // exit promise would hang-then-exit silently before the caller's catch.
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      child.kill();
      child.on("exit", () => resolve());
      // resolve after timeout even if no exit event
      setTimeout(resolve, 1000).unref();
    });
  }

  // ponytail: no reconnect/retry — upgrade path = "add when a caller needs resilience"

  return { call, close };
}
