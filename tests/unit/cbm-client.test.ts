import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createCbmClient } from "../../src/cbm/client.js";

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
});
