import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeResolve } from "../../src/shared/paths.js";

test.each(["../x", "/tmp/x", "%2e%2e/x", "a/%2E%2E/x"])("rejects unsafe path %s", async (path) => {
  await expect(safeResolve("/tmp/project", path)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
});

test("keeps a normal relative path inside base", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gk-paths-"));
  try {
    expect(await safeResolve(dir, "templates/a")).toBe(join(await realpath(dir), "templates/a"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
