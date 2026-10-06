import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import YAML from "yaml";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { formatZodIssues } from "../../src/cli/diagnostics.js";
import { materializeNodeAgents } from "../../src/cli/node-agents.js";
import { isBlocking, validateGraph } from "../../src/compiler/validate.js";
import type { GraphKitError } from "../../src/errors.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { agentDirsFor, agentFileName } from "../../src/targets/registry.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

// A real project root for binding probes: validate + materialize agree on
// .omp/agents (pi target, first in agentDirsFor). Lives next to this file so
// runs are hermetic; removed after the suite.
const PROJECT_ROOT = join(import.meta.dir, ".tmp-validate-project");

beforeAll(() => {
  const agentsDir = join(PROJECT_ROOT, ".omp", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const name of ["software-architect", "code-reviewer", "qa-engineer", "memory-curator"]) {
    writeFileSync(join(agentsDir, `${name}.md`), `# ${name}`, "utf-8");
  }
});

afterAll(() => {
  rmSync(PROJECT_ROOT, { recursive: true, force: true });
});

function loadYaml(name: string) {
  return YAML.parse(readFileSync(join(FIXTURES, name), "utf-8"));
}

// Task 4: validate and node-agents materialization share ONE binding rule.
// "Software Architect" is the canonical CS#6 case: it used to validate (kebab
// in validate) but fail materialization (raw name lookup in node-agents).
describe("agent binding agreement (validate <-> materialize)", () => {
  const TMP = join(import.meta.dir, ".tmp-validate-binding");

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  function projectWithAgents(files: Record<string, string>) {
    mkdirSync(TMP, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const p = join(TMP, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content, "utf-8");
    }
  }

  const bindingGraph = {
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "binding" },
    topology: "diamond",
    nodes: { worker: { agent: "Software Architect", objective: "work", depend_on: [] } },
  };

  test("kebab round-trip: .omp/agents/software-architect.md satisfies both sides", () => {
    projectWithAgents({ ".omp/agents/software-architect.md": "architect fragment" });
    const g = GraphSchema.parse(bindingGraph);
    // validate: no agent-binding finding
    const findings = validateGraph(g, TMP).filter((f) => f.check === "agent-binding");
    expect(findings).toEqual([]);
    // materialize: resolves the same fragment through the same rule
    const mapping = materializeNodeAgents(TMP, g);
    expect(mapping.worker).toBe("gk-worker");
    expect(existsSync(join(TMP, ".omp/agents/gk-worker.md"))).toBe(true);
  });

  test("unknown agent fails naming the file it looked for", () => {
    projectWithAgents({ ".omp/agents/.keep": "" });
    const g = GraphSchema.parse({
      ...bindingGraph,
      nodes: { worker: { agent: "Nonexistent Agent", objective: "work", depend_on: [] } },
    });
    const finding = validateGraph(g, TMP).find((f) => f.check === "agent-binding");
    expect(finding?.message).toContain("nonexistent-agent.md");
    let matErr: GraphKitError | undefined;
    try {
      materializeNodeAgents(TMP, g);
    } catch (e) {
      matErr = e as GraphKitError;
    }
    expect(matErr?.code).toBe("AGENT_NOT_FOUND");
    expect(String(matErr?.details?.hint)).toContain("nonexistent-agent.md");
  });

  test("agentDirsFor derives from the target table (pi first, claude second)", () => {
    const dirs = agentDirsFor("/proj").map((d) => d.slice("/proj/".length));
    expect(dirs).toEqual([".omp/agents", ".claude/agents"]);
  });
});

describe("agentFileName", () => {
  test("lowercases and hyphenates", () => {
    expect(agentFileName("Software Architect")).toBe("software-architect.md");
    expect(agentFileName("Code Reviewer")).toBe("code-reviewer.md");
    expect(agentFileName("QA Engineer")).toBe("qa-engineer.md");
  });
});

describe("schema rejects invalid graphs", () => {
  test("no-agent: zod rejects missing agent field", () => {
    const result = GraphSchema.safeParse(loadYaml("invalid-graph-no-agent.yaml"));
    expect(result.success).toBe(false);
  });

  test("cyclic: zod superRefine rejects cycle", () => {
    const result = GraphSchema.safeParse(loadYaml("invalid-graph-cyclic.yaml"));
    expect(result.success).toBe(false);
  });
});

describe("validateGraph structural checks", () => {
  test("missing-ref: finds refs-exist finding", () => {
    const parsed = GraphSchema.parse(loadYaml("invalid-graph-missing-ref.yaml"));
    const findings = validateGraph(parsed, PROJECT_ROOT);
    expect(findings).toContainEqual(expect.objectContaining({ check: "refs-exist", path: "nodes.scouter.refs" }));
  });

  test("evidence-keys: finds missing required key", () => {
    const parsed = GraphSchema.parse(loadYaml("invalid-graph-missing-ref.yaml"));
    const findings = validateGraph(parsed, PROJECT_ROOT);
    expect(findings).toContainEqual(
      expect.objectContaining({
        check: "evidence-keys",
        path: "evidence.required_keys",
        message: expect.stringContaining("report"),
      }),
    );
  });

  test("loop-exit: finds enabled loop without stop condition", () => {
    const parsed = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "loop-test" },
      topology: "diamond",
      nodes: {
        looper: {
          agent: "Software Architect",
          objective: "research",
          loop: { enabled: true, max_rounds: 5 },
          depend_on: [],
        },
      },
    });
    const findings = validateGraph(parsed, PROJECT_ROOT);
    expect(findings).toContainEqual(expect.objectContaining({ check: "loop-exit", path: "nodes.looper.loop" }));
  });

  test("agent-binding: finds unknown agent", () => {
    const parsed = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "bad-agent" },
      topology: "diamond",
      nodes: {
        worker: { agent: "Nonexistent Agent", objective: "work", depend_on: [] },
      },
    });
    const findings = validateGraph(parsed, PROJECT_ROOT);
    expect(findings).toContainEqual(
      expect.objectContaining({
        check: "agent-binding",
        path: "nodes.worker.agent",
        message: expect.stringContaining("Nonexistent Agent"),
      }),
    );
  });

  // --- memory-augmented + eval-gate (Task 6) ---
  const baseGraph = {
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "g" },
    topology: "memory-augmented",
    topology_config: { inner: { template: "diamond" }, memory: { curator_node: "curator" } },
    nodes: {
      scouter: { agent: "Software Architect", objective: "x" },
      worker: { agent: "Code Reviewer", objective: "y" },
      synthesizer: { agent: "Software Architect", objective: "z" },
      curator: { agent: "Memory Curator", objective: "curate" },
    },
  };

  test("memory-augmented requires inner.template", () => {
    const g = GraphSchema.parse({ ...baseGraph, topology_config: { memory: {} } });
    const findings = validateGraph(g, "/nonexistent-root");
    expect(findings.some((f) => f.check === "memory-inner")).toBe(true);
  });

  test("memory-augmented requires the curator node to exist", () => {
    const g = GraphSchema.parse({
      ...baseGraph,
      topology_config: { inner: { template: "diamond" }, memory: { curator_node: "missing" } },
    });
    const findings = validateGraph(g, "/nonexistent-root");
    expect(findings.some((f) => f.check === "memory-curator-node")).toBe(true);
  });

  test("eval-gate requires eval config", () => {
    const g = GraphSchema.parse({
      ...baseGraph,
      topology: "diamond",
      nodes: {
        worker: { agent: "Code Reviewer", objective: "x" },
        "eval-gate": { agent: "Code Reviewer", objective: "gate", role: "eval-gate", depend_on: ["worker"] },
      },
    });
    const findings = validateGraph(g, "/nonexistent-root");
    expect(findings.some((f) => f.check === "eval-gate-config")).toBe(true);
  });

  test("eval-gate with eval config + depend_on passes its checks", () => {
    const g = GraphSchema.parse({
      ...baseGraph,
      topology: "diamond",
      nodes: {
        worker: { agent: "Code Reviewer", objective: "x" },
        "eval-gate": {
          agent: "Code Reviewer",
          objective: "gate",
          role: "eval-gate",
          depend_on: ["worker"],
          eval: { mode: "work_product" },
        },
      },
    });
    const findings = validateGraph(g, "/nonexistent-root");
    expect(findings.some((f) => f.check === "eval-gate-config")).toBe(false);
  });

  test("valid-diamond: zero findings", () => {
    const parsed = GraphSchema.parse(loadYaml("valid-diamond.yaml"));
    const findings = validateGraph(parsed, PROJECT_ROOT);
    expect(findings).toEqual([]);
  });

  test("constraint source other than human|author emits advisory", () => {
    const g = GraphSchema.parse({
      ...baseGraph,
      topology: "diamond",
      nodes: {
        worker: {
          agent: "Code Reviewer",
          objective: "x",
          constraints: [{ no_write: true }, { source: "agent" }],
        },
      },
    });
    const findings = validateGraph(g, "/nonexistent-root");
    expect(findings.some((f) => f.check === "constraint-source" && !isBlocking(f))).toBe(true);
  });

  test("constraint source human|author emits no advisory", () => {
    const g = GraphSchema.parse({
      ...baseGraph,
      topology: "diamond",
      nodes: {
        worker: {
          agent: "Code Reviewer",
          objective: "x",
          constraints: [{ source: "human" }, { source: "author" }],
        },
      },
    });
    const findings = validateGraph(g, "/nonexistent-root");
    expect(findings.some((f) => f.check === "constraint-source")).toBe(false);
  });

  test("zero-nodes: non-custom topology with no nodes rejected", () => {
    const g = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "empty" },
      topology: "diamond",
      nodes: {},
    });
    expect(validateGraph(g, PROJECT_ROOT)).toContainEqual(
      expect.objectContaining({ check: "zero-nodes", path: "nodes" }),
    );
  });

  test("zero-nodes: custom topology with no nodes is allowed", () => {
    const g = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "empty-custom" },
      topology: "custom",
      nodes: {},
    });
    const findings = validateGraph(g, "/nonexistent-root");
    expect(findings.some((f) => f.check === "zero-nodes")).toBe(false);
  });
  for (const key of ["../report", "nested/report", "/tmp/report", "..\\report"]) {
    test(`rejects non-basename evidence key: ${key}`, () => {
      const g = GraphSchema.parse({ ...baseGraph, topology: "diamond", evidence: { required_keys: [key] } });
      expect(validateGraph(g, PROJECT_ROOT)).toContainEqual(expect.objectContaining({ check: "evidence-key-path" }));
    });
  }
});

// Task 2: one diagnostic envelope. Schema and semantic failures share the
// same `details.issues: Issue[]` shape ({path,message,hint?} + check/severity
// on semantic entries); the details.findings alias is gone.
describe("one diagnostic envelope", () => {
  const TMP = join(import.meta.dir, ".tmp-validate-envelope");

  afterEach(() => {
    process.exitCode = 0; // fail() sets exitCode=1; reset so bun:test exits 0
    rmSync(TMP, { recursive: true, force: true });
  });

  function runValidateCli(args: string[], cwd: string) {
    const cli = cac("gk");
    registerGraphCommands(cli);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    let exitCode = 0;
    let code = 0;
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
      code = exitCode || ((process.exitCode as number | undefined) ?? 0);
      process.exitCode = 0;
    }
    return { stdout: logs.join("\n"), code };
  }

  function writeGraph(mutate: (doc: Record<string, unknown>) => void) {
    mkdirSync(TMP, { recursive: true });
    const doc = YAML.parse(readFileSync(join(FIXTURES, "valid-diamond.yaml"), "utf-8")) as Record<string, unknown>;
    mutate(doc);
    writeFileSync(join(TMP, "graph.yaml"), YAML.stringify(doc), "utf-8");
  }

  test("formatZodIssues maps zod issues to {path,message}", () => {
    const parsed = GraphSchema.safeParse({ apiVersion: "graphkit.dev/v2" });
    if (parsed.success) throw new Error("expected schema failure");
    const issues = formatZodIssues(parsed.error);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue).toHaveProperty("path");
      expect(issue).toHaveProperty("message");
    }
  });

  test("unrecognized key carries a did-you-mean hint", () => {
    const doc = YAML.parse(readFileSync(join(FIXTURES, "valid-diamond.yaml"), "utf-8")) as Record<string, unknown>;
    (doc.nodes as Record<string, unknown>).worker = { ...(doc.nodes as Record<string, unknown>).worker, modle: "opus" };
    const parsed = GraphSchema.safeParse(doc);
    if (parsed.success) throw new Error("expected schema failure");
    const hit = formatZodIssues(parsed.error, GraphSchema).find((i) => i.message.includes("modle"));
    expect(hit?.hint).toBe('did you mean "model"?');
  });

  test("schema-invalid graph through gk validate yields details.issues, not findings", () => {
    writeGraph((doc) => {
      doc.polic_ref = true;
    });
    const { stdout, code } = runValidateCli(["validate", "--json"], TMP);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("SCHEMA_INVALID");
    expect(Array.isArray(parsed.error.details.issues)).toBe(true);
    expect(JSON.stringify(parsed.error.details.issues)).toContain("polic_ref");
    expect(parsed.error.details.findings).toBeUndefined();
  });

  test("semantic failure yields details.issues entries with check+severity", () => {
    writeGraph((doc) => {
      doc.evidence = { required_keys: ["report", "report"] }; // duplicate → advisory
      (doc.nodes as Record<string, unknown>).worker = {
        ...(doc.nodes as Record<string, unknown>).worker,
        refs: [{ path: "missing.md", purpose: "audit" }], // blocking refs-exist
      };
    });
    const { stdout, code } = runValidateCli(["validate", "--json"], TMP);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("VALIDATION_FAILED");
    const issues = parsed.error.details.issues;
    expect(issues.some((i: { check: string }) => i.check === "refs-exist")).toBe(true);
    expect(
      issues.some(
        (i: { check: string; severity?: string }) => i.check === "duplicate-required-key" && i.severity === "warn",
      ),
    ).toBe(true);
    expect(parsed.error.details.findings).toBeUndefined();
  });
});
