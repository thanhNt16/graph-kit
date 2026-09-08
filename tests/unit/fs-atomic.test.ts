import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphKitError } from "../../src/errors.js";
import { _resetRenameSeam, _setRenameSeam, atomicWrite } from "../../src/fs.js";

describe("atomicWrite (shared F6 writer)", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `gk-fs-atomic-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("writes content and creates missing parent dirs", () => {
    const target = join(dir, "nested", "deeper", "file.md");
    atomicWrite(target, "hello\n");
    expect(readFileSync(target, "utf-8")).toBe("hello\n");
  });

  test("replaces existing content in place", () => {
    const target = join(dir, "file.md");
    atomicWrite(target, "before");
    atomicWrite(target, "after");
    expect(readFileSync(target, "utf-8")).toBe("after");
  });

  test("leaves no temp files behind on success", () => {
    const target = join(dir, "file.md");
    atomicWrite(target, "data");
    atomicWrite(target, "data again"); // replacement path must clean up too
    expect(readdirSync(dir)).toEqual(["file.md"]);
  });

  test("rename failure keeps the previous bytes and cleans the temp file", () => {
    const target = join(dir, "file.md");
    atomicWrite(target, "previous");
    _setRenameSeam({
      rename: () => {
        throw new Error("simulated rename failure");
      },
    });
    try {
      expect(() => atomicWrite(target, "next")).toThrow(GraphKitError);
    } finally {
      _resetRenameSeam();
    }
    expect(readFileSync(target, "utf-8")).toBe("previous"); // torn write impossible
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});
