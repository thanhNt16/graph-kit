import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CAC, cac } from "cac";
import { _resetDoctorKitSource, _setDoctorKitSource, registerDoctorCommand } from "../../src/cli/commands/doctor.js";
import { GraphKitError } from "../../src/errors.js";
import { APP_VERSION } from "../../src/version.js";

// Human output stays text, so parse only where a test needs the JSON envelope.
function runDoctorCli(args: string[], cwd: string, register: (cli: CAC) => void) {
  const cli = cac("gk");
  register(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origExit = process.exit;
  const origCwd = process.cwd;
  let code = 0;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  process.exit = (c?: number) => {
    code = c ?? 1;
  };
  process.cwd = () => cwd;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.cwd = origCwd;
  }
  return { code, output: logs.join("\n") };
}

const VALID_GRAPH = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: demo
topology: diamond
nodes:
  a:
    agent: software-architect
    objective: test
    depend_on: []
    evidence: [design]
evidence:
  required_keys: [design]
`;

// bun normalizes process.exitCode back to 0 after it has been set once, so
// pass cases accept "unset or 0" — either means the handler never failed.
function expectCleanExit() {
  expect(process.exitCode ?? 0).toBe(0);
}

describe("gk doctor", () => {
  let root: string;
  let pathFixture: string;
  const origCbmCmd = process.env.CBM_CMD;
  const origCbmArgs = process.env.CBM_ARGS;
  const origPath = process.env.PATH;

  beforeEach(() => {
    root = join(tmpdir(), `gk-doctor-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    // Deterministic $PATH: an empty fixture dir means no `gk` anywhere ahead
    // of the running binary — individual tests drop executables into it.
    pathFixture = join(root, "path-fixture");
    mkdirSync(pathFixture, { recursive: true });
    process.env.PATH = pathFixture;
    // The bridge check must observe this run's env, not the developer shell's.
    delete process.env.CBM_CMD;
    delete process.env.CBM_ARGS;
    process.exitCode = undefined; // prove the pass paths never fail the run
  });
  afterEach(() => {
    process.exitCode = 0; // fail paths set exitCode=1 — reset so bun:test exits 0
    _resetDoctorKitSource();
    process.env.PATH = origPath;
    try {
      chmodSync(join(root, ".graphkit", "memory"), 0o755); // unreadable case must be removable
    } catch {
      /* case not exercised */
    }
    rmSync(root, { recursive: true, force: true });
    if (origCbmCmd !== undefined) process.env.CBM_CMD = origCbmCmd;
    if (origCbmArgs !== undefined) process.env.CBM_ARGS = origCbmArgs;
    else delete process.env.CBM_ARGS;
  });

  function installKit(dir: string, version: string) {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", ".gk.json"), JSON.stringify({ codingLevel: 0, statusline: "full" }));
    writeFileSync(join(dir, ".claude", "metadata.json"), JSON.stringify({ name: "graphkit", version }));
  }

  test("all-clear project: every check ok except the (expected) unconfigured bridge", () => {
    installKit(root, APP_VERSION);
    mkdirSync(join(root, ".graphkit", "memory"), { recursive: true });
    writeFileSync(join(root, "graph.yaml"), VALID_GRAPH);

    const { code, output } = runDoctorCli(["doctor"], root, registerDoctorCommand);
    expect(code).toBe(0);
    expectCleanExit();
    expect(output).toContain(`✓ version`);
    expect(output).toContain(`gk/${APP_VERSION}`);
    expect(output).toContain(`✓ kit`);
    expect(output).toContain(`claude (kit ${APP_VERSION}, fresh)`);
    expect(output).toContain(`✓ graphkit dir`);
    expect(output).toContain(`✓ graph.yaml`);
    expect(output).toContain(`valid (diamond)`);
    expect(output).toContain(`– cbm bridge`);
    expect(output).toContain(`✓ kit source`);
    expect(output).toContain(`✓ PATH shadow`);
    expect(output.trimEnd().endsWith("6 ok, 0 warnings, 0 failures")).toBe(true);
  });

  test("stale kit version warns but still exits 0", () => {
    installKit(root, "0.0.1");

    const { code, output } = runDoctorCli(["doctor"], root, registerDoctorCommand);
    expect(code).toBe(0);
    expectCleanExit();
    expect(output).toContain(`– kit`);
    expect(output).toContain(`claude (kit 0.0.1, stale — run \`gk init\` to refresh)`);
    expect(output).toContain("3 ok, 1 warnings, 0 failures");
  });

  test("unreadable .graphkit/memory fails with MEMORY_DIR_UNREADABLE and exit code 1", () => {
    mkdirSync(join(root, ".graphkit", "memory"), { recursive: true });
    chmodSync(join(root, ".graphkit", "memory"), 0o000);

    const { output } = runDoctorCli(["doctor"], root, registerDoctorCommand);
    expect(process.exitCode).toBe(1); // F6 rule: a failed check is an honest non-zero exit
    expect(output).toContain("✗ graphkit dir");
    expect(output).toContain("MEMORY_DIR_UNREADABLE");
    expect(output).toContain("2 ok, 0 warnings, 1 failures");
  });

  test("--json emits checks array + summary with stable check order", () => {
    const { output } = runDoctorCli(["doctor", "--json"], root, registerDoctorCommand);
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.checks.map((c: { check: string }) => c.check)).toEqual([
      "version",
      "kit",
      "graphkit dir",
      "graph.yaml",
      "cbm bridge",
      "kit source",
      "PATH shadow",
    ]);
    for (const c of parsed.data.checks) {
      expect(["ok", "warn", "fail", "info"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
    }
    // bare temp dir: nothing installed, nothing to validate, bridge expectedly unset
    expect(parsed.data.summary).toEqual({ ok: 2, warnings: 0, failures: 0 });
    expect(parsed.data.checks[1].status).toBe("info");
    expect(parsed.data.checks[1].detail).toBe("no kit installed in this directory (run `gk init`)");
    expect(parsed.data.checks[5].status).toBe("info"); // kit source: nothing to probe
    expect(parsed.data.checks[6].status).toBe("ok"); // PATH shadow: fixture PATH has no gk
  });

  test("invalid graph.yaml fails with the schema error code", () => {
    writeFileSync(
      join(root, "graph.yaml"),
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: broken\ntopology: not-a-topology\nnodes: {}\n`,
    );

    const { output } = runDoctorCli(["doctor"], root, registerDoctorCommand);
    expect(process.exitCode).toBe(1);
    expect(output).toContain("✗ graph.yaml");
    expect(output).toContain("SCHEMA_INVALID");
    expect(output).toContain("1 failures");
  });

  test("kit source check fails with KIT_SOURCE_MISSING + hint when the bundled kits dir is unresolvable", () => {
    installKit(root, APP_VERSION); // a kit IS installed → the probe runs for it
    _setDoctorKitSource(() => {
      throw new GraphKitError("KIT_SOURCE_MISSING", "Bundled kits/claude/ directory not found", {
        hint: "Set GK_KIT_DIR to the kits/claude/ directory",
      });
    });

    const { output } = runDoctorCli(["doctor"], root, registerDoctorCommand);
    expect(process.exitCode).toBe(1); // a missing kit source is a real failure
    expect(output).toContain("✗ kit source");
    expect(output).toContain("KIT_SOURCE_MISSING");
    expect(output).toContain("Bundled kits/claude/ directory not found");
    expect(output).toContain("hint: Set GK_KIT_DIR to the kits/claude/ directory");
    expect(output).toContain("1 failures");
  });

  test("kit source probe stays quiet when nothing is installed", () => {
    const { output } = runDoctorCli(["doctor"], root, registerDoctorCommand);
    expectCleanExit();
    expect(output).toContain("– kit source");
    expect(output).toContain("nothing to probe (no kit installed)");
  });

  test("PATH shadow warns (exit 0) when an executable gk precedes the running binary", () => {
    const shadow = join(pathFixture, "gk");
    writeFileSync(shadow, "#!/bin/sh\n");
    chmodSync(shadow, 0o755);

    const { code, output } = runDoctorCli(["doctor"], root, registerDoctorCommand);
    expect(code).toBe(0);
    expectCleanExit(); // warn never fails the run (doctor contract)
    expect(output).toContain("– PATH shadow");
    expect(output).toContain(shadow);
    expect(output).toContain("0 failures");
  });

  test("PATH shadow ignores non-executable files that merely share the name", () => {
    writeFileSync(join(pathFixture, "gk"), "not an executable");

    const { output } = runDoctorCli(["doctor"], root, registerDoctorCommand);
    expectCleanExit();
    expect(output).toContain("✓ PATH shadow");
    expect(output).toContain("no other gk earlier on $PATH");
  });
});
