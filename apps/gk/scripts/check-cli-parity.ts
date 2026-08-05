/** CLI parity gate for the built bin target. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { CLI_COMMANDS, cliManifest } from "../src/cli/command-registry.js";

const cli = resolve(import.meta.dir, "..", "dist", "index.js");
const run = (...args: string[]) => spawnSync("bun", [cli, ...args], { encoding: "utf8" });
function fail(message: string): never {
  console.error(`check-cli-parity: ${message}`);
  process.exit(1);
}
const names = cliManifest().commands.map((c) => c.name);
const expected = CLI_COMMANDS.map((c) => c.path);
if (JSON.stringify([...names].sort()) !== JSON.stringify([...expected].sort()))
  fail("manifest does not match CLI_COMMANDS");

// Root help must expose exactly the registered top-level commands.
const root = run("--help");
if (root.status !== 0) fail(`built CLI --help failed: ${root.status}`);
const top = [...new Set(expected.map((path) => path.split(" ")[0]))];
for (const command of top)
  if (!(root.stdout + root.stderr).includes(`${command} `)) fail(`missing top-level command '${command}'`);

// A registered leaf must not resolve to the unknown-command handler.
for (const path of expected) {
  const result = run(...path.split(" "), "--help");
  const output = result.stdout + result.stderr;
  const parent = path.split(" ")[0];
  if (!output.includes(`$ gk ${parent}`) || /unknown (?:template|workflow|evidence|manifest) command/.test(output))
    fail(`registered command '${path}' is not reachable in dist/index.js`);
}

// Unknown leaves must fail; otherwise a removed command could pass by printing help.
const unknown = run("template", "__parity_unknown__");
if (unknown.status === 0 || !/unknown template command/.test(unknown.stdout + unknown.stderr))
  fail("unknown command unexpectedly passes parity");

console.log(`check-cli-parity: ${names.length} commands covered in dist/index.js; unknown command rejected`);
