/** CLI parity gate: cli-manifest.json on disk vs the derived surface, and the built bin target. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildCli } from "../src/cli/app.js";
import { cliManifest, commandPaths } from "../src/cli/command-registry.js";

const cli = resolve(import.meta.dir, "..", "dist", "index.js");
/** Run the built CLI from a throwaway cwd so a probe can never mutate the repo. */
function run(...args: string[]): { status: number; stdout: string; stderr: string } {
  const cwd = mkdtempSync(resolve(tmpdir(), "gk-parity-"));
  const result = spawnSync("bun", [cli, ...args], { encoding: "utf8", cwd });
  rmSync(cwd, { recursive: true, force: true });
  return result;
}
function fail(message: string): never {
  console.error(`check-cli-parity: ${message}`);
  process.exit(1);
}
function outputOf(result: { stdout: string; stderr: string }): string {
  return result.stdout + result.stderr;
}
const UNKNOWN_CODES = [
  "UNKNOWN_GRAPH_SUBCOMMAND",
  "UNKNOWN_TEMPLATE_SUBCOMMAND",
  "UNKNOWN_MEMORY_SUBCOMMAND",
  "UNKNOWN_MODELS_SUBCOMMAND",
  "UNKNOWN_RUN_SUBCOMMAND",
  "UNKNOWN_EVIDENCE_SUBCOMMAND",
];
function isUnknownCommand(result: { stdout: string; stderr: string }, _parent: string): boolean {
  try {
    const envelope = JSON.parse(result.stdout) as { status?: string; error?: { code?: string; message?: string } };
    return (
      envelope.status === "fail" && envelope.error?.code !== undefined && UNKNOWN_CODES.includes(envelope.error.code)
    );
  } catch {
    return false;
  }
}
/**
 * The CLI emits every command result as a JSON envelope. A registered leaf is
 * reachable iff invoking it does not fall through to its parent's unknown-
 * command branch. The probe runs in a throwaway cwd so mutating leaves cannot
 * touch the repository; the leaf receives no sub-argument beyond its own name,
 * so it errors fast instead of waiting on a run lock that does not exist.
 */
function leafReachable(path: string): boolean {
  const [parent, leaf] = path.split(" ");
  const result = run(parent, leaf);
  return !isUnknownCommand(result, parent);
}

// 1. Derived surface vs the committed manifest: this is the real drift check.
//    cli-manifest.json is a generated mirror of buildCli(); if registration
//    changed without regenerating, the diff fails here.
const derived = cliManifest(buildCli());
const manifestPath = resolve(import.meta.dir, "..", "cli-manifest.json");
if (!existsSync(manifestPath)) fail("cli-manifest.json missing — run bun run gen:manifest");
const onDisk = JSON.parse(readFileSync(manifestPath, "utf8")) as ReturnType<typeof cliManifest>;
if (JSON.stringify(onDisk) !== JSON.stringify(derived)) {
  fail(
    "cli-manifest.json is stale — registration surface drifted from the committed manifest (run bun run gen:manifest)",
  );
}

// 2. Root help must expose exactly the registered top-level commands.
const expected = commandPaths(buildCli());
const root = run("--help");
if (root.status !== 0) fail(`built CLI --help failed: ${root.status}`);
const top = [...new Set(expected.map((path) => path.split(" ")[0]))];
for (const command of top) if (!outputOf(root).includes(`${command} `)) fail(`missing top-level command '${command}'`);

// 3. Every registered leaf must reach its real handler, not the unknown-leaf fallback.
for (const path of expected) {
  // Top-level commands are covered by the --help check above; probing them as
  // leaves would invoke '<cmd> undefined' and hit the unknown-leaf branch.
  if (!path.includes(" ")) continue;
  if (!leafReachable(path)) fail(`registered command '${path}' is not reachable in dist/index.js`);
}

// 4. Unknown leaves under every parent family must be rejected with a non-zero
// exit; a silently dropped handler would otherwise accept the unknown leaf.
// Only parents with a subcommand dispatch (single-word cmd + action branch)
// reject an unknown leaf; native cac commands (init, new, validate, compile)
// have no unknown-leaf branch.
const parentsWithLeaves = [...new Set(expected.map((path) => path.split(" ")[0]))].filter((parent) =>
  expected.some((path) => path.split(" ").length === 2 && path.startsWith(`${parent} `)),
);
for (const parent of parentsWithLeaves) {
  const unknown = run(parent, "__parity_unknown__");
  if (unknown.status === 0 || !isUnknownCommand(unknown, parent))
    fail(`unknown '${parent}' leaf unexpectedly passes parity`);
}

console.log(
  `check-cli-parity: manifest matches derived surface; ${expected.length} commands reachable in dist/index.js; unknown leaf rejected under each of ${parentsWithLeaves.length} subcommand parents`,
);
