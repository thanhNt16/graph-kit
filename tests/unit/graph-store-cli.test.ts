import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cac } from "cac";
import YAML from "yaml";
import { subcommandsFor } from "../../src/cli/command-registry.js";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";

const TEST_DIR = join(import.meta.dir, ".tmp-store-cli-test");
const graphsDir = () => join(TEST_DIR, ".graphkit", "graphs");
const activeFile = () => join(TEST_DIR, ".graphkit", "active");

function runCli(args: string[], cwd: string) {
  const cli = cac("gk");
  registerGraphCommands(cli);
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

function seedGraph(id: string, name: string, task?: string) {
  const doc = {
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name, ...(task ? { task } : {}) },
    topology: "diamond",
    nodes: { a: { agent: "reviewer", objective: "test", depend_on: [], evidence: [] } },
  };
  writeFileSync(join(graphsDir(), `${id}.yaml`), YAML.stringify(doc), "utf-8");
}

function setActive(id: string) {
  writeFileSync(activeFile(), `${id}\n`, "utf-8");
}

describe("gk graph session commands", () => {
  beforeEach(() => {
    mkdirSync(graphsDir(), { recursive: true });
  });

  afterEach(() => {
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("registers list, switch, show, and topologies in the CLI registry", () => {
    const subcommands = subcommandsFor("graph");
    expect(subcommands).toContain("list");
    expect(subcommands).toContain("switch");
    expect(subcommands).toContain("show");
    expect(subcommands).toContain("topologies");
  });

  it("graph topologies outputs all 11 canonical topologies with descriptions", () => {
    const { stdout, code } = runCli(["graph", "topologies", "--json"], TEST_DIR);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.topologies).toHaveLength(11);
    const names = parsed.data.topologies.map((t: { name: string }) => t.name);
    expect(names).toContain("diamond");
    expect(names).toContain("tournament");
    expect(names).toContain("classify-and-act");
  });

  it("graph topologies renders human table with name and description", () => {
    const { stdout, code } = runCli(["graph", "topologies"], TEST_DIR);
    expect(code).toBe(0);
    expect(stdout).toContain("diamond");
    expect(stdout).toContain("description");
  });

  it("graph list --json returns saved session ids and the active pointer", () => {
    seedGraph("2026-08-26-audit-pr", "audit", "review auth module");
    seedGraph("2026-08-26-refactor", "refactor");
    setActive("2026-08-26-audit-pr");
    const { stdout, code } = runCli(["graph", "list", "--json"], TEST_DIR);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    const ids = parsed.data.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain("2026-08-26-audit-pr");
    expect(ids).toContain("2026-08-26-refactor");
    expect(parsed.data.active).toBe("2026-08-26-audit-pr");
  });

  it("graph list renders a human table with ids, task, created, and last-run columns", () => {
    seedGraph("2026-08-26-audit-pr", "audit", "audit auth module");
    setActive("2026-08-26-audit-pr");
    const { stdout, code } = runCli(["graph", "list"], TEST_DIR);
    expect(code).toBe(0);
    expect(stdout).toContain("last-run");
    expect(stdout).toContain("2026-08-26-audit-pr");
    expect(stdout).toContain("audit");
    expect(stdout).toContain("audit auth module");
    expect(stdout).toContain("-");
  });

  it("graph list fails with ACTIVE_POINTER_DANGLING when active names a missing file", () => {
    seedGraph("2026-08-26-audit-pr", "audit");
    setActive("2026-08-26-ghost");
    const { stdout, code } = runCli(["graph", "list", "--json"], TEST_DIR);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("ACTIVE_POINTER_DANGLING");
  });

  it("graph switch flips .graphkit/active", async () => {
    seedGraph("2026-08-26-audit-pr", "audit");
    seedGraph("2026-08-26-refactor", "refactor");
    setActive("2026-08-26-refactor");
    const { stdout, code } = runCli(["graph", "switch", "2026-08-26-audit-pr", "--json"], TEST_DIR);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.active).toBe("2026-08-26-audit-pr");
    const { getActiveGraphId } = await import("../../src/store/index.js");
    expect(getActiveGraphId(TEST_DIR)).toBe("2026-08-26-audit-pr");
  });

  it("graph switch to a nonexistent id fails with GRAPH_NOT_FOUND", () => {
    seedGraph("2026-08-26-audit-pr", "audit");
    const { stdout, code } = runCli(["graph", "switch", "2026-01-01-ghost", "--json"], TEST_DIR);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("GRAPH_NOT_FOUND");
  });

  it("graph switch rejects a malformed id with INVALID_SESSION_ID", () => {
    seedGraph("2026-08-26-audit-pr", "audit");
    const { stdout, code } = runCli(["graph", "switch", "../evil", "--json"], TEST_DIR);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("INVALID_SESSION_ID");
  });

  it("graph show with no id prints the active graph's YAML", () => {
    seedGraph("2026-08-26-audit-pr", "audit", "review auth module");
    setActive("2026-08-26-audit-pr");
    const { stdout, code } = runCli(["graph", "show"], TEST_DIR);
    expect(code).toBe(0);
    const doc = YAML.parse(stdout);
    expect(doc.metadata.name).toBe("audit");
    expect(doc.metadata.task).toBe("review auth module");
  });

  it("graph show <id> prints that graph's YAML", () => {
    seedGraph("2026-08-26-audit-pr", "audit");
    seedGraph("2026-08-26-refactor", "refactor");
    setActive("2026-08-26-audit-pr");
    const { stdout, code } = runCli(["graph", "show", "2026-08-26-refactor"], TEST_DIR);
    expect(code).toBe(0);
    const doc = YAML.parse(stdout);
    expect(doc.metadata.name).toBe("refactor");
  });

  it("graph show --json returns the parsed graph", () => {
    seedGraph("2026-08-26-audit-pr", "audit");
    setActive("2026-08-26-audit-pr");
    const { stdout, code } = runCli(["graph", "show", "--json"], TEST_DIR);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.id).toBe("2026-08-26-audit-pr");
    expect(parsed.data.graph.metadata.name).toBe("audit");
  });

  it("graph show fails with ACTIVE_POINTER_DANGLING when active names a missing file", () => {
    seedGraph("2026-08-26-audit-pr", "audit");
    setActive("2026-08-26-ghost");
    const { stdout, code } = runCli(["graph", "show"], TEST_DIR);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("ACTIVE_POINTER_DANGLING");
  });

  it("graph show <id> to an unknown id fails with GRAPH_NOT_FOUND", () => {
    seedGraph("2026-08-26-audit-pr", "audit");
    const { stdout, code } = runCli(["graph", "show", "2026-01-01-ghost"], TEST_DIR);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("GRAPH_NOT_FOUND");
  });

  it("graph session commands fail with GRAPHKIT_NOT_INITIALIZED without .graphkit", () => {
    const dir = join(TEST_DIR, "fresh");
    mkdirSync(dir, { recursive: true });
    for (const args of [
      ["graph", "list", "--json"],
      ["graph", "switch", "2026-08-26-audit-pr", "--json"],
      ["graph", "show"],
    ]) {
      const { stdout, code } = runCli(args, dir);
      expect(code).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe("fail");
      expect(parsed.error.code).toBe("GRAPHKIT_NOT_INITIALIZED");
    }
  });

  describe("gk validate without a file argument", () => {
    function seedRootGraph(name = "root-graph") {
      const doc = {
        apiVersion: "graphkit.dev/v2",
        kind: "Graph",
        metadata: { name },
        topology: "diamond",
        nodes: { a: { agent: "reviewer", objective: "test", depend_on: [], evidence: [] } },
      };
      writeFileSync(join(TEST_DIR, "graph.yaml"), YAML.stringify(doc), "utf-8");
    }

    it("reads the active session graph", () => {
      seedGraph("2026-08-26-audit-pr", "audit");
      setActive("2026-08-26-audit-pr");
      seedRootGraph("root-graph");
      const { stdout, code } = runCli(["validate", "--json"], TEST_DIR);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe("ok");
      expect(parsed.data.valid).toBe(true);
    });

    it("surfaces findings from the active session graph over a valid root graph.yaml", () => {
      const doc = {
        apiVersion: "graphkit.dev/v2",
        kind: "Graph",
        metadata: { name: "audit" },
        topology: "diamond",
        nodes: {
          a: {
            agent: "reviewer",
            objective: "test",
            refs: [{ path: "missing.md", purpose: "audit" }],
            depend_on: [],
            evidence: [],
          },
        },
      };
      writeFileSync(join(graphsDir(), "2026-08-26-audit-pr.yaml"), YAML.stringify(doc), "utf-8");
      setActive("2026-08-26-audit-pr");
      seedRootGraph("root-graph");
      const { stdout, code } = runCli(["validate", "--json"], TEST_DIR);
      expect(code).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe("fail");
      expect(parsed.error.code).toBe("VALIDATION_FAILED");
      expect(parsed.error.details.findings.map((f: { check: string }) => f.check)).toContain("refs-exist");
    });

    it("fails with ACTIVE_POINTER_DANGLING when the pointer names a missing graph", () => {
      seedGraph("2026-08-26-audit-pr", "audit");
      setActive("2026-08-26-ghost");
      const { stdout, code } = runCli(["validate", "--json"], TEST_DIR);
      expect(code).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe("ACTIVE_POINTER_DANGLING");
      expect(parsed.error.details.available).toContain("2026-08-26-audit-pr");
    });

    it("falls back to ./graph.yaml when initialized but no active pointer is set", () => {
      seedRootGraph();
      const { stdout, code } = runCli(["validate", "--json"], TEST_DIR);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe("ok");
      expect(parsed.data.valid).toBe(true);
    });

    it("fails with NO_ACTIVE_GRAPH when initialized with neither pointer nor graph.yaml", () => {
      const dir = join(TEST_DIR, "empty-init");
      mkdirSync(join(dir, ".graphkit", "graphs"), { recursive: true });
      const { stdout, code } = runCli(["validate", "--json"], dir);
      expect(code).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe("NO_ACTIVE_GRAPH");
    });

    it("keeps legacy root-graph.yaml behavior when .graphkit is absent", () => {
      seedRootGraph();
      const dir = join(TEST_DIR, "legacy");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "graph.yaml"), readFileSync(join(TEST_DIR, "graph.yaml"), "utf-8"), "utf-8");
      const { stdout, code } = runCli(["validate", "--json"], dir);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe("ok");
    });
  });
});
