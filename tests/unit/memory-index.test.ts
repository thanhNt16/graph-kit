import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CbmClient } from "../../cbm/client.js";
import { _resetMemoryCbmSeam, _setMemoryCbmSeam, indexMemory } from "../../src/cli/commands/memory.js";

const calls: { repoPath: string; name?: string }[] = [];
const fakeClient = { close: async () => {} } as unknown as CbmClient;

beforeEach(() => {
  calls.length = 0;
  _setMemoryCbmSeam({
    clientFactory: () => fakeClient,
    indexProject: async (_client, opts) => {
      calls.push(opts as { repoPath: string; name?: string });
      return { project: opts.name ?? "", indexed: true };
    },
  });
});
afterEach(() => _resetMemoryCbmSeam());

describe("gk memory index", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-mem-idx-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("indexes .graphkit/memory into the named project + writes watermark", async () => {
    const res = await indexMemory(cwd);
    expect(calls[0].repoPath).toBe(join(cwd, ".graphkit", "memory"));
    expect(calls[0].name).toBe("graph-kit-memory"); // default
    expect(res.indexed).toBe(true);
    expect(res.project).toBe("graph-kit-memory");
    const wm = readFileSync(join(cwd, ".graphkit", ".last-index"), "utf-8");
    expect(wm).toBe(res.watermark);
  });

  test("indexMemory never creates a .memory-dirty flag; leaves a stray pre-existing flag untouched", async () => {
    mkdirSync(join(cwd, ".graphkit"), { recursive: true });
    const dirty = join(cwd, ".graphkit", ".memory-dirty");
    writeFileSync(dirty, "123");
    await indexMemory(cwd);
    expect(existsSync(dirty)).toBe(true); // dead flag: indexMemory neither writes nor clears it
    unlinkSync(dirty);
    await indexMemory(cwd);
    expect(existsSync(join(cwd, ".graphkit", ".memory-dirty"))).toBe(false); // no new flag created
  });

  test("project precedence: --project flag beats graph.yaml beats default", async () => {
    writeFileSync(
      join(cwd, "graph.yaml"),
      "topology: memory-augmented\ntopology_config:\n  memory:\n    project: from-yaml\n",
    );
    // graph.yaml wins over default
    await indexMemory(cwd);
    expect(calls.at(-1)?.name).toBe("from-yaml");
    // flag wins over graph.yaml
    await indexMemory(cwd, "from-flag");
    expect(calls.at(-1)?.name).toBe("from-flag");
  });

  test("absent .memory-dirty stays absent after indexMemory (no throw)", async () => {
    // no dirty flag present — should not throw
    await expect(indexMemory(cwd)).resolves.toBeDefined();
    expect(existsSync(join(cwd, ".graphkit", ".memory-dirty"))).toBe(false);
    unlinkSync(join(cwd, ".graphkit", ".last-index")); // cleanup to assert no stray dirty
  });
});
