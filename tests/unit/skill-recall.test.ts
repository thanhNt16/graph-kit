import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerMemoryCommands } from "../../src/cli/commands/memory.js";

function runRecall(cwd: string, query: string) {
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalExit = process.exit;
  const logs: string[] = [];
  let code = 0;
  process.chdir(cwd);
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  process.exit = ((c?: number) => { code = c ?? 1; }) as typeof process.exit;
  try {
    const cli = cac("gk");
    registerMemoryCommands(cli);
    cli.parse(["node", "gk", "memory", "recall", query], { run: true });
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    process.exit = originalExit;
  }
  return { code, payload: JSON.parse(logs.join("\n")) };
}

describe("gk-recall public CLI behavior", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("recall returns live fixture and filters expired memory", () => {
    dir = join(tmpdir(), `gk-recall-cli-${process.pid}-${Date.now()}`);
    mkdirSync(join(dir, ".graphkit", "memory"), { recursive: true });
    writeFileSync(join(dir, ".graphkit", "memory", "live.md"), "---\nid: live\nsalience: 0.9\n---\nGraph validation entry point\n");
    writeFileSync(join(dir, ".graphkit", "memory", "expired.md"), "---\nid: expired\nsalience: 1\nexpired: true\n---\nGraph validation entry point\n");
    const out = runRecall(dir, "graph validation entry point");
    expect(out.code).toBe(0);
    expect(out.payload.status).toBe("ok");
    expect(out.payload.data.results.map((r: { id: string }) => r.id)).toEqual(["live"]);
    expect(out.payload.data).toHaveProperty("malformed", 0);
  });
});