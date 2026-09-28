import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Parse-error hardening (audit FINDING 1 + FINDING 5): an unknown option or a
 * missing option value must not leak a raw CACError stack, and a typo'd command
 * must be named instead of silently swallowed by the F1 bare-help guard.
 * The guard lives at module scope in src/index.ts, so these tests spawn the
 * real CLI entry rather than replaying the wiring in-process.
 */

const CLI = join(import.meta.dir, "..", "..", "src", "index.ts");

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `gk-parse-error-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function spawnCli(args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("CLI parse errors are loud, not stack leaks", () => {
  test("unknown option on a command: stderr names it, help on stdout, exit 1, no stack", async () => {
    const { stdout, stderr, code } = await spawnCli(["status", "--bogus"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown option");
    expect(stdout).not.toContain("CACError");
    expect(stdout).not.toMatch(/^\s+at /m);
    expect(stdout).toContain("Usage:");
  });

  test("missing option value: stderr names it, exit 1, no stack", async () => {
    const { stdout, stderr, code } = await spawnCli(["compile", "--output"]);
    expect(code).toBe(1);
    expect(stderr).toContain("value is missing");
    expect(stdout).not.toContain("CACError");
    expect(stdout).not.toMatch(/^\s+at /m);
  });

  test("unknown command: named on stderr before the help, exit 1", async () => {
    const { stdout, stderr, code } = await spawnCli(["bogus"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown command: bogus");
    expect(stdout).toContain("Usage:");
  });

  test("bare gk keeps the F1 contract: help + exit 1, no unknown-command line", async () => {
    const { stdout, stderr, code } = await spawnCli([]);
    expect(code).toBe(1);
    expect(stdout).toContain("Usage:");
    expect(stderr).not.toContain("Unknown command");
  });
});
