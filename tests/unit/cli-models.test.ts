import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerModelsCommands } from "../../src/cli/commands/models.js";
import { CURSOR_MODEL_DEFAULTS } from "../../src/models/cursor-map.js";

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
  let exit = 0;
  const origExit = process.exit;
  process.exit = (c?: number) => {
    exit = c ?? 1;
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
  return { stdout: logs.join("\n"), code: exit };
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

  test("models cursor prints defaults when no override", () => {
    const { stdout, code } = runCli(["models", "cursor"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.opus).toBe(CURSOR_MODEL_DEFAULTS.opus);
    expect(parsed.data.sonnet).toBe(CURSOR_MODEL_DEFAULTS.sonnet);
  });

  test("models cursor set writes an override file", () => {
    const { stdout, code } = runCli(["models", "cursor", "set", "--map", "sonnet=Claude Sonnet 4.5"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    const file = join(cwd, ".graphkit", "models.cursor.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.sonnet).toBe("Claude Sonnet 4.5");
    expect(parsed.data.sonnet).toBe("Claude Sonnet 4.5");
  });

  test("models cursor reflects an override", () => {
    writeFileSync(join(cwd, ".graphkit", "models.cursor.json"), JSON.stringify({ sonnet: "Claude Sonnet 4.5" }));
    const { stdout, code } = runCli(["models", "cursor"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.sonnet).toBe("Claude Sonnet 4.5");
    expect(parsed.data.opus).toBe(CURSOR_MODEL_DEFAULTS.opus);
  });

  test("models cursor garbage exits nonzero with status fail", () => {
    const { stdout, code } = runCli(["models", "cursor", "garbage"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
  });

  test("models cursor reset clears overrides", () => {
    writeFileSync(join(cwd, ".graphkit", "models.cursor.json"), JSON.stringify({ sonnet: "Claude Sonnet 4.5" }));
    const res = runCli(["models", "cursor", "reset"], cwd);
    expect(res.code).toBe(0);
    const file = join(cwd, ".graphkit", "models.cursor.json");
    expect(existsSync(file)).toBe(false);
  });

  test("models codex show resolves codex defaults", () => {
    const { stdout, code } = runCli(["models", "codex"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.opus).toBe("gpt-5.4");
    expect(parsed.data.sonnet).toBe("gpt-5.3-codex-spark");
  });

  test("models vscode is rejected with target list", () => {
    const { stdout, code } = runCli(["models", "vscode"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_MODELS_SUBCOMMAND");
    expect(parsed.error.details.available).toEqual(["claude", "cursor", "opencode", "codex", "pi"]);
  });

  test("codex overrides persist to .graphkit/models.codex.json", () => {
    const { stdout, code } = runCli(["models", "codex", "set", "--map", "opus=gpt-5.5"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    const file = join(cwd, ".graphkit", "models.codex.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.opus).toBe("gpt-5.5");
    const show = runCli(["models", "codex"], cwd);
    expect(JSON.parse(show.stdout).data.opus).toBe("gpt-5.5");
  });
});
