import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  _resetWriteSeam,
  _setWriteSeam,
  runTemplateList,
  runTemplatePack,
  runTemplateShow,
} from "../../src/cli/commands/template.js";

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

function writeGraph(dir: string, content = DIAMOND) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "graph.yaml"), content);
}

function writeAgent(dir: string) {
  mkdirSync(join(dir, "claude", "agents"), { recursive: true });
  writeFileSync(join(dir, "claude", "agents", "code-reviewer.md"), "# CR\n");
  writeFileSync(join(dir, "claude", "agents", "software-architect.md"), "# SA\n");
}

describe("gk template pack", () => {
  let root: string;
  let cwd: string;
  let home: string;

  beforeEach(() => {
    root = join(tmpdir(), `gk-template-test-${process.pid}-${Date.now()}`);
    cwd = join(root, "proj");
    home = join(root, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeGraph(cwd);
    writeAgent(cwd);
  });

  afterEach(() => {
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
    rmSync(root, { recursive: true, force: true });
    _resetWriteSeam();
  });

  test("packs a zero-parameter template from a valid source graph", () => {
    const res = runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "security-audit" });
    expect(res.status).toBe("ok");
    const data = res.data;
    expect(data.name).toBe("security-audit");
    expect(data.origin).toBe("project");
    const localPath = join(cwd, ".graphkit", "templates", "security-audit.gk.yaml");
    expect(data.path).toBe(localPath);
    expect(existsSync(localPath)).toBe(true);
    expect(data.parameterCount).toBe(0);
    expect(data.recommendationCount).toBe(0);
  });

  test("rejects an unsafe name (traversal)", () => {
    const res = runTemplatePack({
      cwd,
      home,
      file: join(cwd, "graph.yaml"),
      name: "../etc/passwd",
    });
    expect(res.status).toBe("fail");
    expect(res.error.code).toBe("BAD_TEMPLATE_NAME");
    expect(existsSync(join(cwd, ".graphkit", "templates", ".."))).toBe(false);
  });

  test("rejects a name with uppercase / underscores", () => {
    const res = runTemplatePack({
      cwd,
      home,
      file: join(cwd, "graph.yaml"),
      name: "Bad_Name",
    });
    expect(res.status).toBe("fail");
    expect(res.error.code).toBe("BAD_TEMPLATE_NAME");
  });

  test("refuses to overwrite an existing template without --force", () => {
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "security-audit" });
    const res = runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "security-audit" });
    expect(res.status).toBe("fail");
    expect(res.error.code).toBe("TEMPLATE_EXISTS");
  });

  test("--force atomically replaces an existing template", () => {
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "security-audit" });
    const res = runTemplatePack({
      cwd,
      home,
      file: join(cwd, "graph.yaml"),
      name: "security-audit",
      force: true,
    });
    expect(res.status).toBe("ok");
    const localPath = join(cwd, ".graphkit", "templates", "security-audit.gk.yaml");
    const parsed = YAML.parse(readFileSync(localPath, "utf-8"));
    expect(parsed.kind).toBe("GraphTemplate");
    expect(parsed.metadata.name).toBe("security-audit");
  });

  test("simulated rename failure leaves existing bytes intact", () => {
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "security-audit" });
    const localPath = join(cwd, ".graphkit", "templates", "security-audit.gk.yaml");
    const before = readFileSync(localPath, "utf-8");

    _setWriteSeam({
      rename: () => {
        throw new Error("simulated rename failure");
      },
    });
    const res = runTemplatePack({
      cwd,
      home,
      file: join(cwd, "graph.yaml"),
      name: "security-audit",
      force: true,
    });
    _resetWriteSeam();

    expect(res.status).toBe("fail");
    // Existing file untouched; no stray temp file left behind.
    expect(readFileSync(localPath, "utf-8")).toBe(before);
    const dir = join(cwd, ".graphkit", "templates");
    const entries = require("node:fs").readdirSync(dir);
    expect(entries.filter((e: string) => e.endsWith(".tmp"))).toHaveLength(0);
  });

  test("source validation failure prevents any write", () => {
    writeGraph(cwd, "not: valid: yaml: [");
    const res = runTemplatePack({
      cwd,
      home,
      file: join(cwd, "graph.yaml"),
      name: "security-audit",
    });
    expect(res.status).toBe("fail");
    expect(existsSync(join(cwd, ".graphkit", "templates", "security-audit.gk.yaml"))).toBe(false);
  });

  test("--global writes to the user store", () => {
    const res = runTemplatePack({
      cwd,
      home,
      file: join(cwd, "graph.yaml"),
      name: "security-audit",
      global: true,
    });
    expect(res.status).toBe("ok");
    expect(res.data.origin).toBe("global");
    expect(res.data.path).toBe(join(home, ".graphkit", "templates", "security-audit.gk.yaml"));
  });

  test("--input packs a prepared complete GraphTemplate", () => {
    const prepared = {
      apiVersion: "graphkit.dev/v1",
      kind: "GraphTemplate",
      metadata: { name: "security-audit", description: "audit", version: 2 },
      parameters: {
        target: { description: "Code or directory to audit", required: true },
      },
      recommendations: { agents: ["code-reviewer"], tools: ["Read"] },
      graph: {
        apiVersion: "graphkit.dev/v2",
        kind: "Graph",
        metadata: { name: "security-audit", description: "audit" },
        topology: "diamond",
        nodes: {
          reviewer: { agent: "code-reviewer", objective: "Audit {{target}}." },
        },
      },
    };
    const inputPath = join(cwd, "template-input.yaml");
    writeFileSync(inputPath, YAML.stringify(prepared));
    const res = runTemplatePack({
      cwd,
      home,
      file: join(cwd, "graph.yaml"),
      name: "security-audit",
      input: inputPath,
    });
    expect(res.status).toBe("ok");
    expect(res.data.parameterCount).toBe(1);
    expect(res.data.recommendationCount).toBe(2);
  });

  test("reports name/origin/path/counts in a serializable form (text==json)", () => {
    const res = runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "security-audit" });
    const data = res.data as Record<string, unknown>;
    const textKeys = Object.keys(data).sort();
    const json = JSON.parse(JSON.stringify(data));
    expect(Object.keys(json).sort()).toEqual(textKeys);
    expect(json.name).toBe("security-audit");
    expect(json.origin).toBe("project");
    expect(typeof json.path).toBe("string");
    expect(json.parameterCount).toBe(0);
    expect(json.recommendationCount).toBe(0);
  });
});

describe("gk template list / show", () => {
  let root: string;
  let cwd: string;
  let home: string;

  beforeEach(() => {
    root = join(tmpdir(), `gk-template-test-${process.pid}-${Date.now()}`);
    cwd = join(root, "proj");
    home = join(root, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeGraph(cwd);
    writeAgent(cwd);
  });

  afterEach(() => {
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
    rmSync(root, { recursive: true, force: true });
  });

  test("list reports name/description/version/origin and shadowed globals", () => {
    // Global only
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "global-only", global: true });
    // Both local and global → local shadows global
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "shared", global: true });
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "shared" });

    const res = runTemplateList({ cwd, home });
    expect(res.status).toBe("ok");
    const items = res.data.templates;
    const globalOnly = items.find((i: { name: string }) => i.name === "global-only");
    expect(globalOnly.origin).toBe("global");
    expect(globalOnly.shadowed).toBe(false);
    const shared = items.find((i: { name: string }) => i.name === "shared");
    expect(shared.origin).toBe("project");
    expect(shared.shadowed).toBe(true);
    expect(typeof shared.description).toBe("string");
    expect(typeof shared.version).toBe("number");
  });

  test("show resolves local before global", () => {
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "shared", global: true });
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "shared" });
    const res = runTemplateShow({ cwd, home, name: "shared" });
    expect(res.status).toBe("ok");
    expect(res.data.origin).toBe("project");
    expect(res.data.path).toBe(join(cwd, ".graphkit", "templates", "shared.gk.yaml"));
  });

  test("show resolves a global-only template", () => {
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "global-only", global: true });
    const res = runTemplateShow({ cwd, home, name: "global-only" });
    expect(res.status).toBe("ok");
    expect(res.data.origin).toBe("global");
  });

  test("show unknown reports close matches and available names", () => {
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "security-audit" });
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "deploy-flow", global: true });
    const res = runTemplateShow({ cwd, home, name: "security-audit-t" });
    expect(res.status).toBe("fail");
    expect(res.error.code).toBe("TEMPLATE_NOT_FOUND");
    expect(res.error.details.closeMatches).toContain("security-audit");
    expect(res.error.details.available).toContain("security-audit");
    expect(res.error.details.available).toContain("deploy-flow");
  });
});
