import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerModelsCommands } from "../../src/cli/commands/models.js";
import { TARGET_MODEL_DEFAULTS } from "../../src/targets/model-tiers.js";

function fullCli() {
  const cli = cac("gk");
  registerModelsCommands(cli);
  return cli;
}

function runCli(args: string[], cwd: string) {
  const cli = fullCli();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  const origCwd = process.cwd;
  process.cwd = () => cwd;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.cwd = origCwd;
  }
  const code = process.exitCode;
  process.exitCode = origExitCode;
  return { stdout: logs.join("\n"), code };
}

describe("gk models", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "gk-models-"));
    mkdirSync(join(cwd, ".graphkit"), { recursive: true });
  });
  afterEach(() => {
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
    rmSync(cwd, { recursive: true, force: true });
  });

  test("models claude prints defaults when no override", () => {
    const { stdout, code } = runCli(["models", "claude"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.opus).toBe(TARGET_MODEL_DEFAULTS.claude.opus);
    expect(parsed.data.sonnet).toBe(TARGET_MODEL_DEFAULTS.claude.sonnet);
  });

  test("models claude set writes an override file", () => {
    const { stdout, code } = runCli(["models", "claude", "set", "--map", "sonnet=Claude Sonnet 4.5"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    const file = join(cwd, ".graphkit", "models.claude.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.sonnet).toBe("Claude Sonnet 4.5");
    expect(parsed.data.sonnet).toBe("Claude Sonnet 4.5");
  });

  test("models claude reflects an override", () => {
    writeFileSync(join(cwd, ".graphkit", "models.claude.json"), JSON.stringify({ sonnet: "Claude Sonnet 4.5" }));
    const { stdout, code } = runCli(["models", "claude"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.sonnet).toBe("Claude Sonnet 4.5");
    expect(parsed.data.opus).toBe(TARGET_MODEL_DEFAULTS.claude.opus);
  });

  test("models pi resolves empty tier strings - pi resolves models itself", () => {
    const { stdout, code } = runCli(["models", "pi"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.opus).toBe("");
    expect(parsed.data.sonnet).toBe("");
  });

  test("models claude garbage exits nonzero with status fail", () => {
    const { stdout, code } = runCli(["models", "claude", "garbage"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
  });

  test("models claude reset clears overrides", () => {
    writeFileSync(join(cwd, ".graphkit", "models.claude.json"), JSON.stringify({ sonnet: "Claude Sonnet 4.5" }));
    const res = runCli(["models", "claude", "reset"], cwd);
    expect(res.code).toBe(0);
    const file = join(cwd, ".graphkit", "models.claude.json");
    expect(existsSync(file)).toBe(false);
  });

  test("models vscode is rejected with target list", () => {
    const { stdout, code } = runCli(["models", "vscode"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_MODELS_SUBCOMMAND");
    expect(parsed.error.details.available).toEqual(["pi", "claude"]);
  });
});
