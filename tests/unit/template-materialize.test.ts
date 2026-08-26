import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { CLI_COMMANDS } from "../../src/cli/command-registry.js";
import { materializeTemplate, runTemplatePack } from "../../src/cli/commands/template.js";
import { getActiveGraphId, setActiveGraphId } from "../../src/store/index.js";

const MIN_GRAPH = `apiVersion: graphkit.dev/v2
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

function newEnv(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = join(tmpdir(), `gk-mat-${label}-${stamp}`);
  const cwd = join(root, "proj");
  const home = join(root, "home");
  // `.graphkit` alone satisfies store init; graphs/ is created on save.
  mkdirSync(join(cwd, ".graphkit"), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, cwd, home };
}

let cleanup: Array<() => void> = [];

beforeEach(() => {
  cleanup = [];
});

afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

describe("template materialize resolution order", () => {
  test("project-local beats global beats builtin gallery", () => {
    const { root, cwd, home } = newEnv("precedence");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(cwd, "graph.yaml"), MIN_GRAPH);

    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "audit-pr" });
    const projRes = materializeTemplate("audit-pr", { task: "payments" }, { cwd, home });
    expect(projRes.id).toBeDefined();
    expect(projRes.origin).toBe("project");

    rmSync(join(cwd, ".graphkit", "templates", "audit-pr.gk.yaml"));
    runTemplatePack({ cwd, home, file: join(cwd, "graph.yaml"), name: "audit-pr", global: true });
    const globRes = materializeTemplate("audit-pr", { task: "payments" }, { cwd, home });
    expect(globRes.origin).toBe("global");

    rmSync(join(home, ".graphkit", "templates", "audit-pr.gk.yaml"));
    const galRes = materializeTemplate("audit-pr", { task: "prod checkout flow" }, { cwd, home });
    expect(galRes.origin).toBe("gallery");
    expect(existsSync(galRes.path)).toBe(true);
  });

  test("unknown template reports closest available names", () => {
    const { root, cwd, home } = newEnv("unknown");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    try {
      materializeTemplate("no-such-template", {}, { cwd, home });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("Unknown template");
      expect(JSON.stringify(e)).toContain("audit-pr");
    }
  });

  test("malformed template names are rejected before filesystem probes", () => {
    const { root, cwd, home } = newEnv("badname");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    try {
      materializeTemplate("../escape", {}, { cwd, home });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("name must match");
    }
  });
});

const JSON_PROBE_TPL = `apiVersion: graphkit.dev/v1
kind: GraphTemplate
metadata:
  name: json-probe
  description: Structured parameter probe
  version: 1
parameters:
  filters:
    description: Structured filter config
    required: true
recommendations:
  agents: []
graph:
  apiVersion: graphkit.dev/v2
  kind: Graph
  metadata:
    name: json-probe
  topology: custom
  topology_config:
    filters: "{{filters.json}}"
  nodes:
    reviewer:
      agent: code-reviewer
      objective: Check staged filters.
      depend_on: []
      evidence: [filter-notes]
    synthesizer:
      agent: software-architect
      objective: Summarize filter effects.
      depend_on: [reviewer]
      evidence: [filter-report]
  evidence:
    required_keys: [filter-report]
`;

describe("template materialize substitution", () => {
  test("embedded string interpolation and sole-string passthrough", () => {
    const { root, cwd, home } = newEnv("interp");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const res = materializeTemplate("audit-pr", { task: "auth module" }, { cwd, home });
    expect(res.graph.metadata.description).toBe(
      "Adversarial security and quality audit of auth module",
    );
    const reviewer = (res.graph.nodes as Record<string, { objective: string }>).reviewer;
    expect(reviewer.objective).toContain("auth module");
  });

  test("json round-trip substitution keeps structured values", () => {
    const { root, cwd, home } = newEnv("json");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(cwd, ".graphkit", "templates"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "templates", "json-probe.gk.yaml"), JSON_PROBE_TPL);
    const res = materializeTemplate(
      "json-probe",
      { filters: '{"severity":["high"],"paths":["src/auth/**"]}' },
      { cwd, home },
    );
    expect(res.graph.topology_config?.filters).toEqual({
      severity: ["high"],
      paths: ["src/auth/**"],
    });
  });

  test("--use omitted leaves the active pointer untouched", () => {
    const { root, cwd, home } = newEnv("no-use");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    expect(getActiveGraphId(cwd)).toBeNull();
    const res = materializeTemplate("audit-pr", { task: "silent" }, { cwd, home });
    expect(res.active).toBeUndefined();
    expect(getActiveGraphId(cwd)).toBeNull();

    // A previously explicit pointer survives a plain materialize.
    setActiveGraphId(res.id, cwd);
    materializeTemplate("bench-eval", { workload: "qa" }, { cwd, home });
    expect(getActiveGraphId(cwd)).toBe(res.id);
  });

  test("missing required parameter fails listing offending keys", () => {
    const { root, cwd, home } = newEnv("missing-param");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    try {
      materializeTemplate("audit-pr", {}, { cwd, home });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("task");
    }
  });

  test("non-object params fail with BAD_PARAMS, not TypeError", () => {
    const { root, cwd, home } = newEnv("bad-params");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    for (const bad of [
      null as unknown as Record<string, unknown>,
      [1, 2] as unknown as Record<string, unknown>,
    ]) {
      try {
        materializeTemplate("audit-pr", bad, { cwd, home });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toContain("Params must be a JSON object");
      }
    }
    expect(existsSync(join(cwd, ".graphkit", "graphs"))).toBe(false);
  });

  test("invalid substituted graph surfaces validateGraph findings", () => {
    const { root, cwd, home } = newEnv("validation");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(cwd, ".graphkit", "templates"), { recursive: true });
    // Template loads cleanly but its substituted graph has an unproduced
    // required evidence key -> validateGraph must reject before save.
    const tpl = `apiVersion: graphkit.dev/v1
kind: GraphTemplate
metadata:
  name: broken-probe
  description: Fails downstream validation
  version: 1
parameters: {}
recommendations:
  agents: []
graph:
  apiVersion: graphkit.dev/v2
  kind: Graph
  metadata:
    name: broken-probe
  topology: diamond
  nodes:
    reviewer:
      agent: code-reviewer
      objective: Audit the codebase.
      depend_on: []
      evidence: [report]
  evidence:
    required_keys: [report, ghost-key]
`;
    writeFileSync(join(cwd, ".graphkit", "templates", "broken-probe.gk.yaml"), tpl);
    try {
      materializeTemplate("broken-probe", {}, { cwd, home });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("ghost-key");
    }
    expect(existsSync(join(cwd, ".graphkit", "graphs"))).toBe(false);
  });

  test("--use flips the active session pointer to the new graph", () => {
    const { root, cwd, home } = newEnv("use-flag");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const res = materializeTemplate("audit-pr", { task: "telemetry" }, { cwd, home, use: true });
    expect(res.active).toBe(res.id);
    expect(getActiveGraphId(cwd)).toBe(res.id);
  });
  test("gallery roster materializes end-to-end", () => {
    const { root, cwd, home } = newEnv("roster");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const cases: Array<[string, Record<string, string>]> = [
      ["audit-pr", { task: "checkout flow" }],
      ["refactor-module", { module: "src/store", notes: "extract cache layer" }],
      ["bench-eval", { workload: "summarization" }],
      ["doc-sweep", { topic: "installation guide" }],
    ];
    for (const [name, params] of cases) {
      const res = materializeTemplate(name, params, { cwd, home });
      expect(res.id).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/);
      expect(res.path.endsWith(`${res.id}.yaml`)).toBe(true);
      const onDisk = YAML.parse(readFileSync(res.path, "utf-8")) as { kind?: string };
      expect(onDisk.kind).toBe("Graph");
    }
  });

  test("registry exposes the materialize subcommand", () => {
    const cmd = CLI_COMMANDS.find((c) => c.path === "template materialize");
    expect(cmd).toBeDefined();
    expect(cmd?.options.join(" ")).toContain("--use");
  });
});
