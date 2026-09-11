import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CAC } from "cac";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { registerInventoryCommands } from "../../src/cli/commands/inventory.js";
import { registerKitCommands } from "../../src/cli/commands/kit.js";
import { registerMemoryCommands } from "../../src/cli/commands/memory.js";
import { registerTemplateCommands } from "../../src/cli/commands/template.js";
import { APP_VERSION } from "../../src/version.js";
import { createCliHarness } from "../helpers/cli-harness.js";

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

/** Every command family registered, mirroring src/index.ts wiring. */
function registerAll(cli: CAC) {
  registerKitCommands(cli);
  registerGraphCommands(cli);
  registerMemoryCommands(cli);
  registerTemplateCommands(cli);
  registerInventoryCommands(cli);
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
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
    rmSync(root, { recursive: true, force: true });
  });

  const graphFile = () => join(cwd, "graph.yaml");

  test("template pack writes a .gk.yaml and reports counts", () => {
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "template",
      "pack",
      graphFile(),
      "--name",
      "security-audit",
    ]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.name).toBe("security-audit");
    expect(parsed.data.origin).toBe("project");
    expect(parsed.data.parameterCount).toBe(0);
    expect(existsSync(join(cwd, ".graphkit", "templates", "security-audit.gk.yaml"))).toBe(true);
  });

  test("template pack refuses overwrite without --force", () => {
    createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "template",
      "pack",
      graphFile(),
      "--name",
      "security-audit",
    ]);
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "template",
      "pack",
      graphFile(),
      "--name",
      "security-audit",
    ]);
    expect(run.exit).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("TEMPLATE_EXISTS");
  });

  test("template pack requires --name", () => {
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "template",
      "pack",
      graphFile(),
    ]);
    expect(run.exit).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("MISSING_NAME");
  });

  test("template list reports the packed template", () => {
    createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "template",
      "pack",
      graphFile(),
      "--name",
      "security-audit",
    ]);
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run(["template", "list", "--json"]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    const found = parsed.data.templates.find((t: { name: string }) => t.name === "security-audit");
    expect(found).toBeDefined();
    expect(found.origin).toBe("project");
  });

  test("template show resolves the template", () => {
    createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "template",
      "pack",
      graphFile(),
      "--name",
      "security-audit",
    ]);
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "template",
      "show",
      "security-audit",
    ]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.origin).toBe("project");
    expect(parsed.data.description).toBe("Parallel security review");
  });

  test("template show unknown fails with close matches", () => {
    createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "template",
      "pack",
      graphFile(),
      "--name",
      "security-audit",
    ]);
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "template",
      "show",
      "security-audit-t",
    ]);
    expect(run.exit).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("TEMPLATE_NOT_FOUND");
    expect(parsed.error.details.closeMatches).toContain("security-audit");
  });

  test("unknown template subcommand rejected", () => {
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run(["template", "bogus"]);
    expect(run.exit).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_TEMPLATE_SUBCOMMAND");
  });

  test("packed template materializes + validates (graph.yaml round-trip)", () => {
    createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "template",
      "pack",
      graphFile(),
      "--name",
      "security-audit",
    ]);
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "validate",
      graphFile(),
      "--json",
    ]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
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
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
    rmSync(root, { recursive: true, force: true });
  });

  test("gk --version prints the APP_VERSION constant", () => {
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run(["--version"]);
    expect(run.exit).toBeUndefined();
    // cac formats as "gk/<version> <platform>-<arch> node-<runtime>"
    expect(run.stdout.trim()).toContain(APP_VERSION);
    expect(run.stdout).toMatch(/^gk\//);
  });

  test("inventory --target claude --json returns the output contract", () => {
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "inventory",
      "--target",
      "claude",
      "--json",
    ]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.target).toBe("claude");
    expect(parsed.data.agents.some((a: { name: string }) => a.name === "code-reviewer")).toBe(true);
    expect(Array.isArray(parsed.data.skills)).toBe(true);
    expect(Array.isArray(parsed.data.tools)).toBe(true);
    expect(Array.isArray(parsed.data.mcpServers)).toBe(true);
  });

  test("inventory default output is a human table, not JSON", () => {
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "inventory",
      "--target",
      "claude",
    ]);
    expect(run.exit).toBeUndefined();
    expect(() => JSON.parse(run.stdout)).toThrow();
    expect(run.stdout).toContain("target: claude");
    expect(run.stdout).toContain("code-reviewer");
    expect(run.stdout).toContain("agents (1)");
    expect(run.stdout).toContain("tools (20)");
    expect(run.stdout).toContain("warnings: none");
  });

  test("inventory rejects an invalid target", () => {
    const run = createCliHarness(registerAll, { cwd: cwd, version: APP_VERSION }).run([
      "inventory",
      "--target",
      "vscode",
    ]);
    expect(run.exit).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("BAD_TARGET");
  });
});

describe("CLI end-to-end: kit init/new human + --json", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `gk-kit-cli-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
    rmSync(root, { recursive: true, force: true });
  });

  test("init default prints the installed-entries line, not JSON", () => {
    const run = createCliHarness(registerAll, { cwd: root, version: APP_VERSION }).run(["init"]);
    expect(run.exit).toBeUndefined();
    expect(() => JSON.parse(run.stdout)).toThrow();
    expect(run.stdout).toMatch(
      /^installed \d+ entries into \.claude\/ \(target claude\) — next: `gk graph new diamond > graph\.yaml`, then `gk validate`$/,
    );
    expect(existsSync(join(root, ".claude", "skills"))).toBe(true);
  });

  test("init --json keeps the ok(result) envelope", () => {
    const run = createCliHarness(registerAll, { cwd: root, version: APP_VERSION }).run(["init", "--json"]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(Array.isArray(parsed.data.installed)).toBe(true);
    expect(parsed.data.installed.length).toBeGreaterThan(0);
  });

  test("new default prints the created + installed line", () => {
    const dir = join(root, "fresh"); // absolute: fs ops use the real cwd, only process.cwd is stubbed
    const run = createCliHarness(registerAll, { cwd: root, version: APP_VERSION }).run(["new", "--dir", dir]);
    expect(run.exit).toBeUndefined();
    expect(() => JSON.parse(run.stdout)).toThrow();
    expect(run.stdout).toContain(`created ${dir} — installed `);
    expect(run.stdout).toContain("entries into .claude/ (target claude) — next: `gk graph new diamond > graph.yaml`");
  });

  test("new --json keeps the created + installed envelope", () => {
    const dir = join(root, "fresh2");
    const run = createCliHarness(registerAll, { cwd: root, version: APP_VERSION }).run(["new", "--dir", dir, "--json"]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.created).toBe(dir);
    expect(Array.isArray(parsed.data.installed)).toBe(true);
  });

  test("new missing --dir fails with MISSING_DIR (JSON fail envelope in both modes)", () => {
    const human = createCliHarness(registerAll, { cwd: root, version: APP_VERSION }).run(["new"]);
    expect(human.exit).toBe(1);
    expect(JSON.parse(human.stdout).error.code).toBe("MISSING_DIR");
    const json = createCliHarness(registerAll, { cwd: root, version: APP_VERSION }).run(["new", "--json"]);
    expect(json.exit).toBe(1);
    expect(JSON.parse(json.stdout).error.code).toBe("MISSING_DIR");
  });
});
