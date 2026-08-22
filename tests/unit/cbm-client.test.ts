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
});
