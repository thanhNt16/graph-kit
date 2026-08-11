import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { registerInventoryCommands } from "../../src/cli/commands/inventory.js";
import { registerKitCommands } from "../../src/cli/commands/kit.js";
import { registerMemoryCommands } from "../../src/cli/commands/memory.js";
import { registerTemplateCommands } from "../../src/cli/commands/template.js";

const DIAMOND = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: security-audit
  description: Parallel security review
topology: diamond
inputs:
  task:
    type: string
    required: true
nodes:
  reviewer:
    agent: code-reviewer
    objective: Audit the codebase.
    depend_on: []
    evidence: [findings]
  synthesizer:
    agent: software-architect
    objective: Merge findings into a report.
    depend_on: [reviewer]
    evidence: [report]
evidence:
  required_keys: [report]
`;

/** Build the real CLI with every command family registered (mirrors src/index.ts). */
function fullCli() {
  const cli = cac("gk");
  registerKitCommands(cli);
  registerGraphCommands(cli);
  registerMemoryCommands(cli);
  registerTemplateCommands(cli);
  registerInventoryCommands(cli);
  cli.help();
  return cli;
}

function runCli(args: string[], cwd: string) {
  const cli = fullCli();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let exitCode = 0;
  const origExit = process.exit;
  process.exit = (c?: number) => {
    exitCode = c ?? 1;
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
  return { stdout: logs.join("\n"), code: exitCode };
}

describe("CLI end-to-end: template pack/list/show", () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = join(tmpdir(), `gk-cli-e2e-${process.pid}-${Date.now()}`);
    cwd = join(root, "proj");
    mkdirSync(join(cwd, "claude", "agents"), { recursive: true });
    writeFileSync(join(cwd, "claude", "agents", "code-reviewer.md"), "# CR\n");
    writeFileSync(join(cwd, "claude", "agents", "software-architect.md"), "# SA\n");
    writeFileSync(join(cwd, "graph.yaml"), DIAMOND);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const graphFile = () => join(cwd, "graph.yaml");

  test("template pack writes a .gk.yaml and reports counts", () => {
    const { stdout, code } = runCli(["template", "pack", graphFile(), "--name", "security-audit"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.name).toBe("security-audit");
    expect(parsed.data.origin).toBe("project");
    expect(parsed.data.parameterCount).toBe(0);
    expect(existsSync(join(cwd, ".graphkit", "templates", "security-audit.gk.yaml"))).toBe(true);
  });

  test("template pack refuses overwrite without --force", () => {
    runCli(["template", "pack", graphFile(), "--name", "security-audit"], cwd);
    const { stdout, code } = runCli(["template", "pack", graphFile(), "--name", "security-audit"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("TEMPLATE_EXISTS");
  });

  test("template pack requires --name", () => {
    const { stdout, code } = runCli(["template", "pack", graphFile()], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("MISSING_NAME");
  });

  test("template list reports the packed template", () => {
    runCli(["template", "pack", graphFile(), "--name", "security-audit"], cwd);
    const { stdout, code } = runCli(["template", "list"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.templates).toHaveLength(1);
    expect(parsed.data.templates[0].name).toBe("security-audit");
  });

  test("template show resolves the template", () => {
    runCli(["template", "pack", graphFile(), "--name", "security-audit"], cwd);
    const { stdout, code } = runCli(["template", "show", "security-audit"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.origin).toBe("project");
    expect(parsed.data.description).toBe("Parallel security review");
  });

  test("template show unknown fails with close matches", () => {
    runCli(["template", "pack", graphFile(), "--name", "security-audit"], cwd);
    const { stdout, code } = runCli(["template", "show", "security-audit-t"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("TEMPLATE_NOT_FOUND");
    expect(parsed.error.details.closeMatches).toContain("security-audit");
  });

  test("unknown template subcommand rejected", () => {
    const { stdout, code } = runCli(["template", "bogus"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_TEMPLATE_SUBCOMMAND");
  });

  test("packed template materializes + validates (graph.yaml round-trip)", () => {
    runCli(["template", "pack", graphFile(), "--name", "security-audit"], cwd);
    const { stdout, code } = runCli(["validate", graphFile()], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.valid).toBe(true);
  });
});

describe("CLI end-to-end: inventory registration", () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = join(tmpdir(), `gk-inv-cli-${process.pid}-${Date.now()}`);
    cwd = join(root, "proj");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "agents", "code-reviewer.md"),
      "---\nname: code-reviewer\nmodel: opus\n---\nbody\n",
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("inventory --target claude --json returns the output contract", () => {
    const { stdout, code } = runCli(["inventory", "--target", "claude", "--json"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.target).toBe("claude");
    expect(parsed.data.agents.some((a: { name: string }) => a.name === "code-reviewer")).toBe(true);
    expect(Array.isArray(parsed.data.skills)).toBe(true);
    expect(Array.isArray(parsed.data.tools)).toBe(true);
    expect(Array.isArray(parsed.data.mcpServers)).toBe(true);
  });

  test("inventory rejects an invalid target", () => {
    const { stdout, code } = runCli(["inventory", "--target", "vscode"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("BAD_TARGET");
  });
});
