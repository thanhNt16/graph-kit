import { describe, expect, test } from "bun:test";
import { CBM_UNAVAILABLE_MSG, createCbmClient } from "../../src/cbm/client.js";

/**
 * Spawns a fake JSON-RPC responder that echoes each request
 * with {jsonrpc:"2.0", id, result: {ok: true, tool, args}}.
 */
function fakeServer(): { cmd: string; args: string[] } {
  // Inline script: read lines from stdin, parse JSON, echo result with same id
  const script = `
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        const resp = { jsonrpc: '2.0', id: msg.id, result: { ok: true, tool: msg.params?.name, args: msg.params?.arguments } };
        process.stdout.write(JSON.stringify(resp) + '\\n');
      } catch {}
    });
  `;
  return { cmd: "node", args: ["-e", script] };
}

describe("cbm client", () => {
  test("call resolves with echoed result", async () => {
    const { cmd, args } = fakeServer();
    const client = createCbmClient({ cmd, args });
    const result = await client.call<{ ok: boolean; tool: string }>("ping", {});
    expect(result.ok).toBe(true);
    expect(result.tool).toBe("ping");
    await client.close();
  });

  test("call passes args through", async () => {
    const { cmd, args } = fakeServer();
    const client = createCbmClient({ cmd, args });
    const result = await client.call<{ args: Record<string, unknown> }>("index_repository", {
      repo_path: "/tmp/fake",
      mode: "fast",
    });
    expect(result.args.repo_path).toBe("/tmp/fake");
    expect(result.args.mode).toBe("fast");
    await client.close();
  });

  test("close exits cleanly", async () => {
    const { cmd, args } = fakeServer();
    const client = createCbmClient({ cmd, args });
    await client.call("ping", {});
    await client.close();
    // no throw = pass
    expect(true).toBe(true);
  });

  // --- F3: honest spawn-death (the bridge can't work — npm 404) ---

  test("spawn file-not-found rejects with CBM_UNAVAILABLE contract, not a bare errno", async () => {
    // A command that cannot exist — simulates `npx -y @graphkit/codebase-memory-mcp` failing to spawn.
    const client = createCbmClient({ cmd: "definitely-not-a-real-binary-xyz" });
    try {
      await expect(client.call("index_repository", {})).rejects.toThrow(/CBM bridge unavailable/);
    } finally {
      await client.close();
    }
  });

  test("spawn-death message carries CBM_CMD/CBM_ARGS guidance + the 404 explanation", async () => {
    const client = createCbmClient({ cmd: "definitely-not-a-real-binary-xyz" });
    try {
      await client.call("index_repository", {}).then(
        () => {
          throw new Error("should have rejected");
        },
        (e: Error) => {
          expect(e.message).toContain("CBM_CMD");
          expect(e.message).toContain("CBM_ARGS");
          expect(e.message).toContain("npm 404");
          expect(e.message).toContain(CBM_UNAVAILABLE_MSG);
        },
      );
    } finally {
      await client.close();
    }
  });

  test("child that exits before handshake rejects pending call and buffers stderr tail", async () => {
    // A server that writes to stderr then exits immediately (0) without answering.
    const script = "process.stderr.write('runtime exploded on import\\n'); process.exit(0);";
    const client = createCbmClient({ cmd: "node", args: ["-e", script] });
    try {
      await client.call("index_repository", {}).then(
        () => {
          throw new Error("should have rejected");
        },
        (e: Error) => {
          expect(e.message).toContain("runtime exploded on import"); // buffered stderr tail surfaced
          expect(e.message).toContain("CBM bridge unavailable");
        },
      );
    } finally {
      await client.close();
    }
  });

  test("calls made after the child died reject immediately with the same contract", async () => {
    const client = createCbmClient({ cmd: "definitely-not-a-real-binary-xyz" });
    // Let the spawn-failure settle, then a fresh call must reject fast (no write to a corpse).
    await new Promise((r) => setTimeout(r, 50));
    try {
      await expect(client.call("search_graph", {})).rejects.toThrow(/CBM bridge unavailable/);
    } finally {
      await client.close();
    }
  });

  test("close() on a spawn-failed (ENOENT) child resolves fast — sawExit, not the 1s fallback", async () => {
    // ENOENT fires "error" WITHOUT "exit": exitCode/signalCode stay null forever,
    // so the old close() attached an exit listener no event would ever run and
    // burned the full 1s fallback timer on every such client (~3s of this suite).
    const client = createCbmClient({ cmd: "definitely-not-a-real-binary-xyz" });
    // Let the spawn failure settle, then close must resolve immediately.
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await Promise.race([
      client.close(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("close() hung on spawn-failed child")), 200)),
    ]);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  test("close() on an already-dead child resolves immediately — no hang before the caller's catch (regression pin)", async () => {
    // Real spawn path: node exits at once (0) before any call, exactly the
    // spawn-death case that made `memory index --json` exit 0 silently.
    const client = createCbmClient({ cmd: "node", args: ["-e", "process.exit(0);"] });
    // Let the child die for real, THEN run the caller's finally-close ordering.
    await new Promise((r) => setTimeout(r, 100));
    // Call must reject with the honest contract (not hang).
    await expect(client.call("index_repository", {})).rejects.toThrow(/CBM bridge unavailable/);
    // close() must resolve NOW: the old code attached the exit listener after
    // the event was already emitted and leaned on an unref'd 1s timer that does
    // not hold the event loop — in the CLI that silently exited 0 before the
    // catch printed CBM_UNAVAILABLE. 200ms proves instant; old code took ~1s.
    await Promise.race([
      client.close(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("close() deadlocked on dead child")), 200)),
    ]);
  });

  // --- round 4: no dead-bridge spawn + per-call timeout ---

  test("unconfigured bridge (no opts, no env) throws immediately — no npx spawn on a guaranteed 404", () => {
    const prevCmd = process.env.CBM_CMD;
    const prevArgs = process.env.CBM_ARGS;
    delete process.env.CBM_CMD;
    delete process.env.CBM_ARGS;
    try {
      const t0 = Date.now();
      expect(() => createCbmClient()).toThrow(/CBM bridge unavailable/);
      // The old path burned ~800ms spawning `npx -y` into an E404 first.
      expect(Date.now() - t0).toBeLessThan(50);
    } finally {
      if (prevCmd !== undefined) process.env.CBM_CMD = prevCmd;
      if (prevArgs !== undefined) process.env.CBM_ARGS = prevArgs;
    }
  });

  test("CBM_CMD env alone still spawns (explicit config is never refused)", async () => {
    const prevCmd = process.env.CBM_CMD;
    const { cmd, args } = fakeServer();
    process.env.CBM_CMD = cmd;
    // CBM_ARGS unset → falls back to the npx default args; the fake server
    // ignores its args, so only the command matters here.
    delete process.env.CBM_ARGS;
    const client = createCbmClient({ args });
    try {
      process.env.CBM_CMD = prevCmd;
      const result = await client.call<{ ok: boolean }>("ping", {});
      expect(result.ok).toBe(true);
    } finally {
      await client.close();
      if (prevCmd !== undefined) process.env.CBM_CMD = prevCmd;
    }
  });

  test("a wedged-but-alive bridge times out into the unavailable envelope instead of hanging", async () => {
    // Server reads stdin forever but never answers — the old code left the
    // promise pending indefinitely.
    const script = `process.stdin.resume();`;
    const client = createCbmClient({ cmd: "node", args: ["-e", script], callTimeoutMs: 100 });
    try {
      await client.call("search_graph", {}).then(
        () => {
          throw new Error("should have rejected");
        },
        (e: Error) => {
          expect(e.message).toContain("CBM bridge unavailable");
          expect(e.message).toContain("timeout after 0s");
        },
      );
    } finally {
      await client.close();
    }
  });

  test("a response that arrives before the timeout still resolves", async () => {
    const { cmd, args } = fakeServer();
    const client = createCbmClient({ cmd, args, callTimeoutMs: 5000 });
    try {
      const result = await client.call<{ ok: boolean }>("ping", {});
      expect(result.ok).toBe(true);
    } finally {
      await client.close();
    }
  });
});
