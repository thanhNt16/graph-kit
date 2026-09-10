// tests/unit/cli-hints-resolve.test.ts
// D3 guard: onboarding hints ARE the next step — a backticked `gk …` command in
// any CLI output string must name a real top-level command. `gk init-graph`
// (a session skill, not a CLI command) once sent users into the unknown-command
// path; this keeps that class of drift out.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_COMMANDS } from "../../src/cli/command-registry.js";

const TOP_LEVEL = new Set(CLI_COMMANDS.map((c) => c.path.split(" ")[0]));
const COMMANDS_DIR = join(import.meta.dir, "..", "..", "src", "cli", "commands");

describe("CLI output hints reference real commands", () => {
  for (const file of readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".ts"))) {
    test(`${file}: every backticked gk … hint resolves against CLI_COMMANDS`, () => {
      const src = readFileSync(join(COMMANDS_DIR, file), "utf-8");
      // `gk <cmd>[ args/flags]` inside backticks — the first token decides.
      const hints = [...src.matchAll(/`gk ([a-z][a-z-]*)[\s`]/g)].map((m) => m[1]);
      const unknown = [...new Set(hints.filter((cmd) => !TOP_LEVEL.has(cmd)))];
      expect(unknown).toEqual([]);
    });
  }
});
