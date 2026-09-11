// tests/unit/memory-cli-errors.test.ts
// E1: the `gk memory` catch blocks (MEMORY_TRACE_FAILED / MEMORY_TOUCH_FAILED /
// MEMORY_NOT_FOUND / UNKNOWN_MEMORY_SUBCOMMAND / MEMORY_DIR_UNREADABLE) had
// zero assertions — the "corrupt store must exit via the JSON contract, not a
// raw stack trace" promise was unenforced. Uses the shared cli-harness from
// day one (E3).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Round 4: usage honesty + store inspection surfaces.
describe("gk memory CLI list/show/touch usage (round 4)", () => {
  test('touch without id → MISSING_ARG, not id "undefined"', () => {
    const cli = createCliHarness(registerMemoryCommands, { cwd: root });
    const run = cli.run(["memory", "touch"]);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("MISSING_ARG");
    expect(parsed.error.message).not.toContain("undefined");
    expect(run.exit).toBe(1);
  });

  test("list reports id, status, salience, use_count, file (json + human)", () => {
    writeFileSync(
      join(root, ".graphkit", "memory", "a.md"),
      "---\nid: alpha\ntype: knowledge\nsalience: 0.7\nuse_count: 3\n---\nbody\n",
    );
    const cli = createCliHarness(registerMemoryCommands, { cwd: root });
    const json = JSON.parse(cli.run(["memory", "list", "--json"]).stdout);
    expect(json.status).toBe("ok");
    expect(json.data.total).toBe(1);
    expect(json.data.memories[0]).toMatchObject({ id: "alpha", status: "live", salience: 0.7, use_count: 3 });
    const human = cli.run(["memory", "list"]).stdout;
    expect(human).toContain("alpha");
    expect(human).toContain("live");
  });

  test("show prints the raw file (human) or frontmatter+body envelope (json); unknown id → MEMORY_NOT_FOUND with ids", () => {
    writeFileSync(join(root, ".graphkit", "memory", "a.md"), "---\nid: alpha\ntype: knowledge\n---\nsecret body\n");
    const cli = createCliHarness(registerMemoryCommands, { cwd: root });
    const human = cli.run(["memory", "show", "alpha"]).stdout;
    expect(human).toContain("secret body");
    const json = JSON.parse(cli.run(["memory", "show", "alpha", "--json"]).stdout);
    expect(json.status).toBe("ok");
    expect(json.data.frontmatter.id).toBe("alpha");
    expect(json.data.body).toContain("secret body");
    const miss = cli.run(["memory", "show", "nope", "--json"]);
    const parsed = JSON.parse(miss.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("MEMORY_NOT_FOUND");
    expect(parsed.error.details.available).toContain("alpha");
    expect(miss.exit).toBe(1);
  });

  test("trace --dry-run writes nothing and echoes dry_run", () => {
    writeFileSync(
      join(root, ".graphkit", "memory", "stale.md"),
      "---\nid: stale\ntype: knowledge\nsalience: 0.1\nvalid_from: 2026-01-01T00:00:00.000Z\n---\nbody\n",
    );
    const before = readFileSync(join(root, ".graphkit", "memory", "stale.md"), "utf-8");
    const cli = createCliHarness(registerMemoryCommands, { cwd: root });
    const run = cli.run(["memory", "trace", "--json", "--dry-run"]);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.dry_run).toBe(true);
    expect(parsed.data.memories[0].action).toBe("would-expire");
    expect(readFileSync(join(root, ".graphkit", "memory", "stale.md"), "utf-8")).toBe(before);
    expect(existsSync(join(root, ".graphkit", ".trace-log"))).toBe(false);
  });
});
