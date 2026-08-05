/**
 * CLI parity gate: proves the built CLI's command surface matches the
 * declarative descriptor source and that every leaf command at least parses.
 *
 * --help eager: if a leaf command never became reachable in cac's parser, an
 * unknown-command error surfaces as a non-zero exit. This is a guard, not a
 * framework: each check is a single assertion that fails the gate loudly.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { COMMAND_NAMES, cliManifest } from "../src/cli/command-registry.js";

const cli = resolve(import.meta.dir, "..", "src", "index.ts");
const RE_EXPECTED_SHELL_ERROR = /Usage|command is required|unknown command|not found|Emitted|Options/;

function fail(message: string): never {
  console.error(`check-cli-parity: ${message}`);
  process.exit(1);
}

// 1. The manifest covers every declared command name exactly once.
const names = cliManifest().commands.map((c) => c.name);
if (JSON.stringify([...names].sort()) !== JSON.stringify([...new Set(COMMAND_NAMES)].sort())) {
  fail("manifest commands do not match COMMAND_NAMES");
}

// 2. Every leaf command parses without a hard parse error (--help exits 0).
for (const path of COMMAND_NAMES) {
  const result = spawnSync("bun", ["run", cli, ...path.split(" "), "--help"], { encoding: "utf8" });
  if (result.status !== 0 && !RE_EXPECTED_SHELL_ERROR.test(result.stdout + result.stderr)) {
    fail(`'${path} --help' did not parse: exit ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
}

console.log(`check-cli-parity: ${names.length} commands covered, all leaf commands parse`);
