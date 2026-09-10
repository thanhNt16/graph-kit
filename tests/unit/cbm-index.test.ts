// tests/unit/cbm-index.test.ts
// E4: src/cbm/index.ts was the only 0%-covered module — the DI seam swallowed
// indexProject in every CLI test, so a dropped/renamed JSON-RPC param would
// ship unnoticed. Assert the wire shape with a recording stub.
import { describe, expect, test } from "bun:test";
import type { CbmClient } from "../../src/cbm/client.js";
import { indexProject } from "../../src/cbm/index.js";

function recordingClient() {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const client = {
    call: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return { ok: true };
    },
    close: async () => {},
  } as unknown as CbmClient;
  return { client, calls };
}

describe("indexProject wire shape", () => {
  test("maps repoPath/name/mode onto the index_repository params", async () => {
    const { client, calls } = recordingClient();
    const out = await indexProject(client, { repoPath: "/repo", name: "proj", mode: "full" });
    expect(calls).toEqual([{ tool: "index_repository", args: { repo_path: "/repo", name: "proj", mode: "full" } }]);
    expect(out).toEqual({ project: "proj", indexed: true });
  });

  test("omits optional keys so server-side defaults stay authoritative", async () => {
    const { client, calls } = recordingClient();
    const out = await indexProject(client, { repoPath: "/repo" });
    expect(calls[0]?.args).toEqual({ repo_path: "/repo" });
    expect(out.project).toBe("/repo");
  });
});
