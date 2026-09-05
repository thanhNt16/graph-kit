import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerEvidenceCommand } from "../../src/cli/commands/evidence.js";

let cwd: string;
const graphYaml = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
nodes:
  probe:
    agent: a
    objective: o
    depend_on: []
    evidence: [api-response]
evidence:
  required_keys: [api-response]
`;

function runCli(args: string[]) {
  const origCwd = process.cwd();
  process.chdir(cwd);
  const cli = cac("gk");
  registerEvidenceCommand(cli);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let code = 0;
  const origExit = process.exit;
  process.exit = ((c?: number) => {
    code = c ?? 1;
  }) as typeof process.exit;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
    console.log = origLog;
    process.exit = origExit;
    process.chdir(origCwd);
  }
  return { stdout: logs.join("\n"), code };
}

beforeEach(() => {
  cwd = join(tmpdir(), `gk-evcli-${process.pid}-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(cwd, ".omp", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".omp", "agents", "a.md"), "# A\n");
  writeFileSync(join(cwd, "graph.yaml"), graphYaml);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("gk evidence add", () => {
  test("adds artifact via CLI", () => {
    writeFileSync(join(cwd, "r.json"), "{}");
    const r = runCli(["evidence", "add", "r.json", "--key", "api-response", "--node", "probe", "--json"]);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("ok");
    expect(env.data.key).toBe("api-response");
    expect(env.data.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("undeclared key exits 1 with code", () => {
    writeFileSync(join(cwd, "r.json"), "{}");
    const r = runCli(["evidence", "add", "r.json", "--key", "bogus", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("EVIDENCE_KEY_NOT_DECLARED");
  });

  test("missing --key fails fast", () => {
    const r = runCli(["evidence", "add", "r.json", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("MISSING_ARG");
  });

  test("unknown leaf rejected", () => {
    const r = runCli(["evidence", "bogus", "--json"]);
    expect(JSON.parse(r.stdout).error.code).toBe("UNKNOWN_EVIDENCE_SUBCOMMAND");
  });
});
