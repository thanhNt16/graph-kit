import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeResolve } from "../../src/shared/paths.js";

test.each(["../x", "/tmp/x", "%2e%2e/x", "a/%2E%2E/x"])("rejects unsafe path %s", async (path) => {
  await expect(safeResolve("/tmp/project", path)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
});

test.each(["C:\\x", "\\server\\share", "\\foo", "C:/x"])("rejects rooted path %s", async (path) => {
  await expect(safeResolve("/tmp/project", path)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
});

test("rejects deeply nested encoded traversal beyond a 10-pass ceiling", async () => {
  let encoded = "../x";
  for (let i = 0; i < 12; i++) encoded = encodeURIComponent(encoded);
  await expect(safeResolve("/tmp/project", encoded)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
});

test("rejects malformed percent encoding", async () => {
  await expect(safeResolve("/tmp/project", "a/%zz/x")).rejects.toMatchObject({ code: "UNSAFE_PATH" });
});

test("keeps a normal relative path inside base", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gk-paths-"));
  try {
    expect(await safeResolve(dir, "templates/a")).toBe(join(await realpath(dir), "templates/a"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a symlink inside base that resolves outside it", async () => {
  const base = await mkdtemp(join(tmpdir(), "gk-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "gk-paths-out-"));
  try {
    await symlink(outside, join(base, "link"));
    await expect(safeResolve(base, "link/x")).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects base/link/missing where link resolves outside base", async () => {
  const base = await mkdtemp(join(tmpdir(), "gk-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "gk-paths-out-"));
  try {
    await symlink(outside, join(base, "link"));
    await expect(safeResolve(base, "link/missing")).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
