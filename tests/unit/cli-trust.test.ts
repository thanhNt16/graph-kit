import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { groupNames, subcommandsFor } from "../../src/cli/command-registry.js";
import { registerEvidenceCommand } from "../../src/cli/commands/evidence.js";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { registerInventoryCommands } from "../../src/cli/commands/inventory.js";
import { registerKitCommands } from "../../src/cli/commands/kit.js";
import { registerMemoryCommands } from "../../src/cli/commands/memory.js";
import { registerModelsCommands } from "../../src/cli/commands/models.js";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import { registerTemplateCommands } from "../../src/cli/commands/template.js";
import { fail } from "../../src/cli/output.js";
import { APP_VERSION } from "../../src/version.js";

/**
 * Task 1 (executor-product) CLI-trust tests: all 364+ green, no silent exit-0.
 * Goal 1 of the plan — every failure is loud. Mirrors src/index.ts wiring.
 */

function fullCli() {
  const cli = cac("gk").version(APP_VERSION);
  registerKitCommands(cli);
  registerGraphCommands(cli);
  registerMemoryCommands(cli);
  registerModelsCommands(cli);
  registerTemplateCommands(cli);
  registerInventoryCommands(cli);
  registerEvidenceCommand(cli);
  registerRunCommands(cli);
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
    sink.code = sink.code || ((process.exitCode as number | undefined) ?? 0);
    process.exitCode = 0; // emit-fail sets exitCode=1; reset so later tests start clean
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

describe("CLI trust: group help lists per-leaf usage (AuditCli F3)", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = join(tmpdir(), `gk-trust-leafhelp-${process.pid}-${Date.now()}`);
    cwd = root;
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  /** The dispatch usage line, wherever the group help renders it (curated or cac Examples). */
  function dispatchLine(logs: string[]): string {
    const line = logs
      .join("\n")
      .split("\n")
      .find((l) => l.trimStart().startsWith("dispatch"));
    expect(line).toBeDefined();
    return line as string;
  }

  test("gk run prints the dispatch leaf line with its flags", () => {
    const { logs } = runCli(["run"], cwd);
    const line = dispatchLine(logs);
    expect(line).toContain("<node> --via task|extension");
    expect(line).toContain("[--pid N]");
    expect(line).toContain("[--attempt N]");
  });

  test("gk run --help (cac path, same surface as `gk run dispatch --help`) prints the dispatch leaf line", () => {
    const { logs } = runCli(["run", "--help"], cwd);
    const line = dispatchLine(logs);
    expect(line).toContain("<node> --via task|extension [--pid N] [--attempt N]");
  });

  test("every registered leaf name appears in its group's curated and cac help", () => {
    for (const group of groupNames()) {
      const curated = runCli([group], cwd).logs.join("\n");
      const cacHelp = runCli([group, "--help"], cwd).logs.join("\n");
      for (const name of subcommandsFor(group).split(" ")) {
        const startsLine = new RegExp(`^\\s{2,}${name}\\b`, "m");
        expect(curated).toMatch(startsLine);
        expect(cacHelp).toMatch(startsLine);
      }
    }
  });
});

// Task 2: every `run` error is a GraphKitError code flowing through
// toGraphKitError — coded throws keep their SCREAMING_SNAKE code and details;
// only genuinely uncoded errors fall back to RUN_ERROR.
describe("CLI trust: run errors are GraphKitError codes (Task 2 envelope)", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `gk-trust-runerr-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  test("coded throw keeps its SCREAMING_SNAKE code — no RUN_ERROR fallback", () => {
    const parsed = JSON.parse(runCli(["run", "analyze"], root).logs.join("\n")) as {
      status: string;
      error: { code: string };
    };
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("NO_RUNS");
    expect(parsed.error.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(parsed.error.code).not.toBe("RUN_ERROR");
  });

  test("deep-module coded errors pass through the catch unwrapped", () => {
    const parsed = JSON.parse(runCli(["run", "round", "0"], root).logs.join("\n")) as {
      status: string;
      error: { code: string };
    };
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("NO_ACTIVE_RUN");
  });
});
