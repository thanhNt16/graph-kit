import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, writeJsonAtomic } from "../../src/shared/files.js";
import { withDirectoryLock } from "../../src/shared/lock.js";

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
    expect(await readdir(dir)).toEqual(["run.json"]);
  });

  test("refuses to overwrite an immutable checkpoint", async () => {
    const target = join(dir, "checkpoint.json");
    await writeJsonAtomic(target, { v: 1 }, true);
    await expect(writeJsonAtomic(target, { v: 2 }, true)).rejects.toMatchObject({
      code: "MODIFIED_TARGET",
    });
  });

  test("concurrent immutable writers: exactly one succeeds", async () => {
    const target = join(dir, "checkpoint.json");
    const results = await Promise.allSettled([
      writeJsonAtomic(target, { v: 1 }, true),
      writeJsonAtomic(target, { v: 2 }, true),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].status).toBe("rejected");
    if (rejected[0].status === "rejected") {
      expect((rejected[0].reason as { code?: string }).code).toBe("MODIFIED_TARGET");
    }
    expect(await readdir(dir)).toEqual(["checkpoint.json"]);
  });

  test("failed write cleans up its temp directory", async () => {
    const target = join(dir, "sub", "run.json");
    await expect(writeJsonAtomic(target, { a: 1 })).rejects.toThrow();
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
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

  test("only whole lines survive and no temp remains", async () => {
    const log = join(dir, "events.jsonl");
    await appendEvent(log, { a: 1 });
    await appendEvent(log, { b: 2 });
    const content = await readFile(log, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    for (const line of content.split("\n").filter((l) => l.length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(await readdir(dir)).toEqual(["events.jsonl"]);
  });

  test("concurrent public appends preserve every whole event line", async () => {
    const log = join(dir, "events.jsonl");
    await Promise.all(Array.from({ length: 3 }, (_, seq) => appendEvent(log, { seq })));
    const lines = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((event) => event.seq))).toEqual(new Set([0, 1, 2]));
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

  test("releases the lock when the callback throws", async () => {
    await expect(
      withDirectoryLock(dir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await withDirectoryLock(dir, async () => {});
  });
});
