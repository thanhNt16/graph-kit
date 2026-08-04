import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, withDirectoryLock, writeJsonAtomic } from "../../src/shared/files.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gk-files-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  test("round-trips a JSON value", async () => {
    const target = join(dir, "run.json");
    await writeJsonAtomic(target, { run_id: "r1", status: "done" });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ run_id: "r1", status: "done" });
  });

  test("leaves no .tmp-* siblings behind", async () => {
    const target = join(dir, "run.json");
    await writeJsonAtomic(target, { a: 1 });
    const entries = await readdir(dir);
    expect(entries).toEqual(["run.json"]);
  });

  test("refuses to overwrite an immutable checkpoint", async () => {
    const target = join(dir, "checkpoint.json");
    await writeJsonAtomic(target, { v: 1 }, true);
    await expect(writeJsonAtomic(target, { v: 2 }, true)).rejects.toMatchObject({
      code: "MODIFIED_TARGET",
    });
  });
});

describe("appendEvent", () => {
  test("appends JSON lines in order", async () => {
    const log = join(dir, "events.jsonl");
    await appendEvent(log, { seq: 1 });
    await appendEvent(log, { seq: 2 });
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ seq: 1 }, { seq: 2 }]);
  });
});

describe("withDirectoryLock", () => {
  test("runs callbacks whose lock spans never overlap across concurrent workers", async () => {
    const active: number[] = [];
    const record = async (id: number) => {
      await withDirectoryLock(dir, async () => {
        active.push(id);
        await new Promise((r) => setTimeout(r, 20));
        expect(active).toEqual([id]);
        active.pop();
      });
    };
    await Promise.all([record(1), record(2), record(3)]);
  });
});
