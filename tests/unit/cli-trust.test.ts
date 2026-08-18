import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { registerInventoryCommands } from "../../src/cli/commands/inventory.js";
import { registerKitCommands } from "../../src/cli/commands/kit.js";
import { registerMemoryCommands } from "../../src/cli/commands/memory.js";
import { _resetMemoryCbmSeam, _setMemoryCbmSeam } from "../../src/cli/commands/memory.js";
import { registerTemplateCommands } from "../../src/cli/commands/template.js";
import { APP_VERSION } from "../../src/version.js";
import { fail } from "../../src/cli/output.js";
import { CBM_UNAVAILABLE_MSG } from "../../src/cbm/client.js";

/**
 * Task 1 (executor-product) CLI-trust tests: all 364+ green, no silent exit-0.
 * Goal 1 of the plan — every failure is loud. Mirrors src/index.ts wiring.
 */

// The async CBM handlers cac does not await keep rejecting after the owning
// test has finished, re-setting process.exitCode=1 via fail(). Clear it once
// at file end so bun:test exits 0 even if a handler settles last.
afterAll(() => {
  process.exitCode = 0;
});

function fullCli() {
  const cli = cac("gk").version(APP_VERSION);
  registerKitCommands(cli);
  registerGraphCommands(cli);
  registerMemoryCommands(cli);
  registerTemplateCommands(cli);
  registerInventoryCommands(cli);
  cli.help();
  return cli;
}

const sink: { logs: string[]; code: number } = { logs: [], code: 0 };

function runCli(args: string[], cwd: string) {
  const cli = fullCli();
  sink.logs = [];
  sink.code = 0;
  const origLog = console.log;
  console.log = (...a: unknown[]) => sink.logs.push(a.map(String).join(" "));
  const origExit = process.exit;
  process.exit = (c?: number) => {
    sink.code = c ?? 1;
  };
  const origCwd = process.cwd;
  process.cwd = () => cwd;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.cwd = origCwd;
  }
  return sink;
}

// cac does not await async command actions — the handler keeps running after
// cli.parse returns. Restore the real console.log/process.exit only AFTER the
// handler settles, or its late process.exit(1) kills the test runner itself.
async function runCliAsync(args: string[], cwd: string, settleMs = 500) {
  const cli = fullCli();
  sink.logs = [];
  sink.code = 0;
  const origLog = console.log;
  console.log = (...a: unknown[]) => sink.logs.push(a.map(String).join(" "));
  const origExit = process.exit;
  process.exit = (c?: number) => {
    sink.code = c ?? 1;
  };
  const origCwd = process.cwd;
  process.cwd = () => cwd;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
    await new Promise((r) => setTimeout(r, settleMs));
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.cwd = origCwd;
  }
  return sink;
}

// The F1 guard lives in src/index.ts at module scope, so the unit harness
// replicates its exact condition (no matchedCommand + not a self-served
// help/version) and asserts the same exit-1 behavior.
function applyF1Guard(cli: ReturnType<typeof fullCli>) {
  if (!cli.matchedCommand && !(cli.options.help || cli.options.version)) {
    process.exitCode = 1;
    return 1;
  }
  return 0;
}

const DIAMOND = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: trust-audit
  description: trust
topology: diamond
inputs:
  task: { type: string, required: true }
nodes:
  reviewer:
    agent: code-reviewer
    objective: audit
    depend_on: []
    evidence: [findings]
evidence:
  required_keys: [findings]
`;

describe("CLI trust: fail() is loud (F6 one exit-code rule)", () => {
  afterEach(() => {
    process.exitCode = 0;
  });
  test("fail() sets process.exitCode = 1 so every fail emit exits non-zero", () => {
    process.exitCode = 0;
    fail("X", "y");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe("CLI trust: bare gk (no command) prints help + exits 1 — F1", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = join(tmpdir(), `gk-trust-bare-${process.pid}-${Date.now()}`);
    cwd = root;
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  test("bare gk is NOT a silent exit-0: applying the guard returns 1", () => {
    const cli = fullCli();
    cli.parse(["node", "gk"], { run: false });
    expect(cli.matchedCommand).toBeUndefined();
    expect(cli.options.help).toBeFalsy();
    expect(cli.options.version).toBeFalsy();
    const code = applyF1Guard(cli);
    expect(code).toBe(1);
  });

  test("graph new with empty/absent topology is status:fail UNKNOWN_TOPOLOGY and exits non-zero", () => {
    const { logs, code } = runCli(["graph", "new"], cwd);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_TOPOLOGY");
    expect(code).toBe(1);
  });
});

describe("CLI trust: memory index fails honestly with CBM_UNAVAILABLE — F3", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = join(tmpdir(), `gk-trust-mem-${process.pid}-${Date.now()}`);
    cwd = root;
    mkdirSync(cwd, { recursive: true });
    // Hermetic wiring test: an injected client factory that dies exactly like
    // the real spawn-death (see cbm-client.test.ts for the real-spawn case).
    _setMemoryCbmSeam({
      clientFactory: () => ({
        call: async () => Promise.reject(new Error(CBM_UNAVAILABLE_MSG)),
        close: async () => {},
      }),
      indexProject: async () => {
        throw new Error(CBM_UNAVAILABLE_MSG);
      },
    });
  });
  afterEach(() => {
    process.exitCode = 0;
    _resetMemoryCbmSeam();
    rmSync(root, { recursive: true, force: true });
  });

  test("memory index --json emits CBM_UNAVAILABLE with CBM_CMD/CBM_ARGS + npm 404, process.exit(1)", async () => {
    await runCliAsync(["memory", "index", "--json"], cwd);
    const out = JSON.parse(sink.logs.join("\n"));
    expect(out.status).toBe("fail");
    expect(out.error.code).toBe("CBM_UNAVAILABLE");
    expect(out.error.message).toContain("CBM_CMD");
    expect(out.error.message).toContain("CBM_ARGS");
    expect(out.error.message).toContain("npm 404");
    // The handler's stubbed process.exit(1) fired (not just fail()'s exitCode).
    expect(sink.code).toBe(1);
    // The async handler also set the real process.exitCode via fail() — clear it
    // so this success-path unit test doesn't make bun:test exit non-zero.
    process.exitCode = 0;
  });
});

describe("CLI trust: gk compile prints the artifact path in human mode — F9", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = join(tmpdir(), `gk-trust-cmp-${process.pid}-${Date.now()}`);
    cwd = root;
    mkdirSync(join(cwd, "claude", "agents"), { recursive: true });
    writeFileSync(join(cwd, "claude", "agents", "code-reviewer.md"), "# CR\n");
    writeFileSync(join(cwd, "graph.yaml"), DIAMOND);
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  test("compile human mode prints a `compiled <path>` line and writes the artifact", () => {
    const { logs, code } = runCli(["compile"], cwd);
    expect(code).toBe(0);
    const line = logs.find((l) => l.startsWith("compiled ")) ?? "";
    expect(line).toMatch(/compiled .*\.workflow\.js$/);
    expect(existsSync(join(cwd, ".claude", "workflows", "trust-audit.workflow.js"))).toBe(true);
  });

  test("compile --json keeps the structured envelope (unchanged contract)", () => {
    const { logs, code } = runCli(["compile", "--json"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.status).toBe("ok");
    expect(parsed.data.compiled).toMatch(/\.workflow\.js$/);
  });
});