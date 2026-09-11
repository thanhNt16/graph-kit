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
  /** Per-call response timeout in ms (default 60000, env CBM_TIMEOUT_MS). 0 disables. */
  callTimeoutMs?: number;
}

// F3: the CBM package is unpublished (npm 404) and we deliberately do NOT
// resurrect the bridge — it can't work. When the child dies before a call
// resolves we surface one honest, actionable return contract instead.
export const CBM_UNAVAILABLE_MSG = `CBM bridge unavailable: @graphkit/codebase-memory-mcp is not published (npm 404). Point CBM_CMD / CBM_ARGS at a local codebase-memory-mcp build, or skip graph index|search|ask|trace|query and memory index.`;

// Typed fatal-bridge failure so callers can distinguish "bridge down" from a
// per-query miss — ask/route must rethrow it, not fail-open into "zero hits".
export class CbmUnavailableError extends Error {}

export function isCbmUnavailable(e: unknown): boolean {
  return e instanceof CbmUnavailableError || (e instanceof Error && e.message.includes(CBM_UNAVAILABLE_MSG));
}

function unavailable(detail: string): CbmUnavailableError {
  return new CbmUnavailableError(`${CBM_UNAVAILABLE_MSG}${detail}`);
}

export function createCbmClient(opts?: CbmClientOpts): CbmClient {
  // Unconfigured bridge: the fallback `npx -y @graphkit/codebase-memory-mcp`
  // target is unpublished, so spawning it burns ~800ms on a guaranteed npm
  // E404 before surfacing the error below anyway. Fail in 0ms instead —
  // explicit CBM_CMD / CBM_ARGS (or opts) still spawn a real bridge.
  if (opts?.cmd === undefined && opts?.args === undefined && !process.env.CBM_CMD && !process.env.CBM_ARGS) {
    throw new CbmUnavailableError(CBM_UNAVAILABLE_MSG);
  }
  const cmd = opts?.cmd ?? process.env.CBM_CMD ?? "npx";
  const args =
    opts?.args ?? (process.env.CBM_ARGS ? process.env.CBM_ARGS.split(" ") : ["-y", "@graphkit/codebase-memory-mcp"]);
  const cwd = opts?.cwd;
  const envTimeout = Number(process.env.CBM_TIMEOUT_MS);
  const callTimeoutMs = opts?.callTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 60_000);

  const child = spawn(cmd, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let idCounter = 0;
  let fatal: CbmUnavailableError | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  // Buffer stderr (instead of draining) so the tail is included in the
  // CBM_UNAVAILABLE message — the user sees WHY the bridge died.
  let stderrBuf = "";
  let started = false;
  // F6: set the moment the child can never speak again — the "exit" event, or
  // the "error" event for a spawn failure (Bun/Node emit error WITHOUT exit on
  // ENOENT, and exitCode/signalCode stay null forever in that case). close()
  // reads it to avoid re-arming a listener for an event already delivered.
  let sawExit = false;

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
    sawExit = true; // spawn failure: there is no child, no exit event will ever come
    fatal = unavailable(`\nspawn ${cmd} failed: ${err.message}`);
    rejectAll(fatal);
  });

  // Child exited before any call resolved — the bridge couldn't come up.
  // Set fatal even with zero pending: a LATER call would otherwise write to a
  // corpse and hang (stdin callback never errs), the same silent-exit class.
  child.on("exit", (_code, _signal) => {
    sawExit = true;
    if (!fatal) {
      const withoutDetail = started ? `\n${cmd} exited unexpectedly.` : `\n${cmd} exited before handshake.`;
      const detail = stderrBuf.trim() !== "" ? `\nstderr tail: ${stderrBuf.trim()}` : withoutDetail;
      fatal = unavailable(detail);
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
      // A wedged-but-alive bridge (accepted the write, never replies) used to
      // hang the promise forever — only child exit/error rejected. Arm a
      // per-call timer so the caller gets the standard unavailable envelope.
      const timer =
        callTimeoutMs > 0
          ? setTimeout(() => {
              pending.delete(id);
              reject(unavailable(`\ntimeout after ${Math.round(callTimeoutMs / 1000)}s waiting for ${tool} response`));
            }, callTimeoutMs)
          : undefined;
      timer?.unref();
      pending.set(id, {
        resolve: (v: unknown) => {
          if (timer) clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e: Error) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      const msg = `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: tool, arguments: args },
      })}\n`;
      child.stdin!.write(msg, (err) => {
        if (err) {
          pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(unavailable(`\nstdin write failed: ${err.message}`));
        }
      });
    });
  }

  function close(): Promise<void> {
    // Already-dead child: sawExit/exitCode/signalCode tell us the exit (or
    // spawn-error) event already fired, so a freshly attached exit listener
    // would never run — awaiting the exit promise would hang-then-exit
    // silently before the caller's catch. Invariant: sawExit is set
    // synchronously by the error/exit handlers above, before close() could
    // miss the event, so this check is race-free.
    if (sawExit || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      child.kill();
      const killTimer = setTimeout(() => {
        // F6: escalate — a child that ignored SIGTERM must not be orphaned by close().
        child.kill("SIGKILL");
        resolve();
      }, 1000);
      killTimer.unref();
      child.on("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  // ponytail: no reconnect/retry — upgrade path = "add when a caller needs resilience"

  return { call, close };
}
