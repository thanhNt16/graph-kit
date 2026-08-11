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
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
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

  child.stderr?.on("data", () => {}); // drain

  function call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
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
          reject(err);
        }
      });
    });
  }

  function close(): Promise<void> {
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
