// tests/unit/cli-usage-errors.test.ts
// D2: the first thing a new user does is mistype something — the CLI must
// answer with a one-line usage error (and a did-you-mean when one is close),
// never a silent help dump or a raw CACError stack.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { suggestCommand } from "../../src/cli/command-registry.js";

describe("suggestCommand", () => {
  test("finds the closest top-level command", () => {
    expect(suggestCommand("memmory")).toBe("memory");
    expect(suggestCommand("gaph")).toBe("graph");
    expect(suggestCommand("statuz")).toBe("status");
  });

  test("returns null when nothing is within edit distance 2", () => {
    expect(suggestCommand("frobnicate")).toBeNull();
    expect(suggestCommand("x")).toBeNull();
  });
});

describe("CLI usage errors (built binary)", () => {
  const dist = join(import.meta.dir, "..", "..", "dist", "index.js");
  // The entrypoint lives in the bundle — skip (with a note) when it hasn't
  // been built; `bun run ci:local` always builds before testing.
  const distReady = existsSync(dist);

  test.skipIf(!distReady)("unknown command gets a one-line usage error, not the help dump", () => {
    const r = spawnSync("node", [dist, "frobnicate"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown command "frobnicate"');
    expect(r.stdout).not.toContain("Usage:");
  });

  test.skipIf(!distReady)("mistyped command suggests the closest real command", () => {
    const r = spawnSync("node", [dist, "memmory"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown command "memmory"');
    expect(r.stderr).toContain("did you mean `memory`?");
  });

  test.skipIf(!distReady)("mistyped flag gets a clean one-liner, not a CACError stack", () => {
    const r = spawnSync("node", [dist, "graph", "--badflag"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown option");
    expect(r.stderr).not.toContain("CACError");
    expect(r.stderr.trim().split("\n").length).toBe(1);
  });

  test.skipIf(!distReady)("bare `gk` still prints help and exits 1 (F1)", () => {
    const r = spawnSync("node", [dist], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Usage:");
  });
});
