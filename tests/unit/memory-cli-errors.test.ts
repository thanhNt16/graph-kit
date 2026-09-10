// tests/unit/memory-cli-errors.test.ts
// E1: the `gk memory` catch blocks (MEMORY_TRACE_FAILED / MEMORY_TOUCH_FAILED /
// MEMORY_NOT_FOUND / UNKNOWN_MEMORY_SUBCOMMAND / MEMORY_DIR_UNREADABLE) had
// zero assertions — the "corrupt store must exit via the JSON contract, not a
// raw stack trace" promise was unenforced. Uses the shared cli-harness from
// day one (E3).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMemoryCommands } from "../../src/cli/commands/memory.js";
import { createCliHarness } from "../helpers/cli-harness.js";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `gk-mem-cli-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, ".graphkit", "memory"), { recursive: true });
});

afterEach(() => {
  process.exitCode = 0; // fail() sets it — reset so bun:test exits 0
  rmSync(root, { recursive: true, force: true });
});

describe("gk memory CLI error envelopes", () => {
  test("corrupt frontmatter store: trace still succeeds by skipping malformed", () => {
    writeFileSync(join(root, ".graphkit", "memory", "broken.md"), "---\ntags: [unclosed\n---\nbody");
    const cli = createCliHarness(registerMemoryCommands, { cwd: root });
    const run = cli.run(["memory", "trace"]);
    // The malformed convention drops, never fatal — the pass reports zeros.
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(run.exit).toBeUndefined();
  });

  test("touch with unknown id → MEMORY_NOT_FOUND fail envelope + exit 1", () => {
    const cli = createCliHarness(registerMemoryCommands, { cwd: root });
    const run = cli.run(["memory", "touch", "no-such-id"]);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("MEMORY_NOT_FOUND");
    expect(run.exit).toBe(1);
    expect(run.exitCode).toBe(1);
  });

  test("unknown subcommand → UNKNOWN_MEMORY_SUBCOMMAND with available list", () => {
    const cli = createCliHarness(registerMemoryCommands, { cwd: root });
    const run = cli.run(["memory", "frobnicate"]);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_MEMORY_SUBCOMMAND");
    expect(parsed.error.details.available).toContain("recall");
    expect(run.exit).toBe(1);
  });

  test("recall with unreadable store → MEMORY_DIR_UNREADABLE fail envelope", () => {
    writeFileSync(join(root, ".graphkit", "memory", "note.md"), "---\nid: note\ntype: knowledge\n---\nbody\n");
    chmodSync(join(root, ".graphkit", "memory"), 0o000);
    let run: ReturnType<typeof createCliHarness> extends never ? never : { stdout: string; exit?: number };
    try {
      const cli = createCliHarness(registerMemoryCommands, { cwd: root });
      run = cli.run(["memory", "recall", "anything", "--json"]);
    } finally {
      chmodSync(join(root, ".graphkit", "memory"), 0o755); // restore before rmSync cleanup
    }
    const parsed = JSON.parse(run.stdout); // JSON contract holds — no raw stack trace
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("MEMORY_DIR_UNREADABLE");
    expect(run.exit).toBe(1);
  });
});
