import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const graphFile = join(FIXTURES, "minimal-diamond.yaml");

function scaffoldProject(dir: string) {
  mkdirSync(join(dir, "claude", "agents"), { recursive: true });
  writeFileSync(join(dir, "claude", "agents", "software-architect.md"), "# SA\n");
  writeFileSync(join(dir, "claude", "agents", "code-reviewer.md"), "# CR\n");
}

function runCli(args: string[], _cwd?: string) {
  const cli = cac("gk");
  registerGraphCommands(cli);

  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => logs.push(a.map(String).join(" "));

  let exitCode = 0;
  const origExit = process.exit;
  process.exit = (c?: number) => {
    exitCode = c ?? 1;
  };

  // Suppress cac's default error handler which calls process.exit
  let error: Error | undefined;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } catch (e) {
    error = e as Error;
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    process.exit = origExit;
  }

  return { stdout: logs.join("\n"), code: exitCode, error };
}

describe("gk graph commands", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `gk-graph-cmd-test-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    scaffoldProject(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("graph list outputs all 8 topologies", () => {
    const { stdout, code } = runCli(["graph", "list"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.topologies).toHaveLength(8);
    expect(parsed.data.topologies).toContain("diamond");
    expect(parsed.data.topologies).toContain("tournament");
  });

  test("graph inspect diamond outputs config keys", () => {
    const { stdout, code } = runCli(["graph", "inspect", "diamond"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.topology).toBe("diamond");
    expect(parsed.data.config_keys).toContain("fanout.strategy");
    expect(parsed.data.config_keys).toContain("reduce");
  });

  test("graph inspect nonexistent fails with UNKNOWN_TOPOLOGY", () => {
    const { stdout } = runCli(["graph", "inspect", "nonexistent"]);
    // process.exit is overridden to not actually exit, but code is captured
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_TOPOLOGY");
    expect(parsed.error.details.available).toHaveLength(8);
  });

  test("validate on minimal-diamond.yaml — schema parse succeeds", () => {
    const { stdout } = runCli(["validate", graphFile]);
    const parsed = JSON.parse(stdout);
    // Schema parse must succeed; findings about missing refs are acceptable
    if (parsed.status === "fail") {
      expect(parsed.error.code).not.toBe("SCHEMA_INVALID");
    }
  });
});
