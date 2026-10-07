import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

const PREVIEW_TEMPLATE = `apiVersion: graphkit.dev/v1
kind: GraphTemplate
metadata: { name: preview-tpl, description: d, version: 1 }
parameters:
  target:
    type: string
    required: false
    default: world
graph:
  apiVersion: graphkit.dev/v2
  kind: Graph
  metadata: { name: "inner-{{target}}" }
  topology: custom
  nodes:
    step1: { agent: code-reviewer, objective: "review {{target}}" }
`;
const TYPO_TEMPLATE = PREVIEW_TEMPLATE.replace("code-reviewer", "qa-enginer");
const REQUIRED_PARAM_TEMPLATE = PREVIEW_TEMPLATE.replace(
  "    required: false\n    default: world\n",
  "    required: true\n",
);
const graphFile = join(FIXTURES, "minimal-diamond.yaml");

function scaffoldProject(dir: string) {
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  writeFileSync(join(dir, ".claude", "agents", "software-architect.md"), "# SA\n");
  writeFileSync(join(dir, ".claude", "agents", "code-reviewer.md"), "# CR\n");
}

function runCli(args: string[], _cwd?: string) {
  const cli = cac("gk");
  registerGraphCommands(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let exitCode = 0;
  let code = 0;
  const origExit = process.exit;
  process.exit = (c?: number) => {
    exitCode = c ?? 1;
  };
  const origCwd = process.cwd;
  if (_cwd) process.cwd = () => _cwd;
  let error: Error | undefined;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } catch (e) {
    error = e as Error;
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    process.exit = origExit;
    process.cwd = origCwd;
    code = exitCode || ((process.exitCode as number | undefined) ?? 0);
    process.exitCode = 0; // emit-fail sets exitCode=1; reset so later tests start clean
  }
  return { stdout: logs.join("\n"), code, error };
}

describe("gk graph commands", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = join(tmpdir(), `gk-graph-cmd-test-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    scaffoldProject(tmp);
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("graph list reports session graphs in initialized cwd", () => {
    mkdirSync(join(tmp, ".graphkit", "graphs"), { recursive: true });
    const { stdout, code } = runCli(["graph", "list", "--json"], tmp);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.sessions).toEqual([]);
    expect(parsed.data.active).toBeNull();
  });
  test("graph inspect diamond outputs config keys", () => {
    const { stdout, code } = runCli(["graph", "inspect", "diamond"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.topology).toBe("diamond");
    expect(parsed.data.config_keys).toContain("fanout.strategy");
    expect(parsed.data.config_keys).toContain("reduce");
  });
  test("graph inspect nonexistent fails with UNKNOWN_TOPOLOGY", () => {
    const parsed = JSON.parse(runCli(["graph", "inspect", "nonexistent"]).stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_TOPOLOGY");
    expect(parsed.error.details.available).toHaveLength(11);
  });
  test("validate on minimal-diamond.yaml — schema parse succeeds", () => {
    const parsed = JSON.parse(runCli(["validate", graphFile]).stdout);
    if (parsed.status === "fail") expect(parsed.error.code).not.toBe("SCHEMA_INVALID");
  });
  test("waves outputs golden topological plan on minimal-diamond.yaml", () => {
    const out = runCli(["graph", "waves", graphFile]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      status: "ok",
      data: {
        graph: "test-graph",
        topology: "diamond",
        topology_config: {},
        total_waves: 3,
        total_nodes: 3,
        waves: [
          {
            wave: 0,
            parallel: false,
            nodes: [
              {
                id: "scouter",
                agent: "Software Architect",
                model: "opus",
                objective: "Analyze the codebase",
                tools: ["Read", "Glob", "Grep"],
                skills: [],
                refs: [],
                depend_on: [],
                loop: null,
                evidence: ["attack_surface"],
                advisor: null,
                fan_out: null,
                retry: null,
                when: null,
                budget_tokens: null,
                gate: null,
                role: null,
                eval: null,
                effort: "standard",
                timeout_ms: null,
                constraints: [],
                assumptions: [],
                owns: [],
                hooks: [],
              },
            ],
          },
          {
            wave: 1,
            parallel: false,
            nodes: [
              {
                id: "worker",
                agent: "Code Reviewer",
                model: "sonnet",
                objective: "Audit assigned files",
                tools: [],
                skills: [],
                refs: [],
                depend_on: ["scouter"],
                loop: null,
                evidence: ["findings"],
                advisor: null,
                fan_out: null,
                retry: null,
                when: null,
                budget_tokens: null,
                gate: null,
                role: null,
                eval: null,
                effort: "standard",
                timeout_ms: null,
                constraints: [],
                assumptions: [],
                owns: [],
                hooks: [],
              },
            ],
          },
          {
            wave: 2,
            parallel: false,
            nodes: [
              {
                id: "synthesizer",
                agent: "Software Architect",
                model: "opus",
                objective: "Merge findings into a report",
                tools: [],
                skills: [],
                refs: [],
                depend_on: ["worker"],
                loop: null,
                evidence: ["report"],
                advisor: null,
                fan_out: null,
                retry: null,
                when: null,
                budget_tokens: null,
                gate: null,
                role: null,
                eval: null,
                effort: "standard",
                timeout_ms: null,
                constraints: [],
                assumptions: [],
                owns: [],
                hooks: [],
              },
            ],
          },
        ],
        evidence_required: ["report"],
        on_graph_complete: [],
        warnings: [],
      },
    });
  });
  test("waves rejects an empty graph through schema validation", () => {
    const file = join(tmp, "empty.yaml");
    writeFileSync(file, "");
    const out = runCli(["graph", "waves", file]);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout).error.code).toBe("SCHEMA_INVALID");
    expect(out.stdout).not.toContain("TypeError");
  });
  test("waves rejects unresolved curator dependencies instead of returning a partial plan", () => {
    const file = join(tmp, "stalled.yaml");
    writeFileSync(
      file,
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata: { name: stalled }\ntopology: memory-augmented\nnodes:\n  curator: { agent: software-architect, objective: curate, depend_on: [] }\n  worker: { agent: code-reviewer, objective: work, depend_on: [curator] }\ntopology_config:\n  inner: { template: custom }\n  memory: { curator_node: curator }\nevidence: { required_keys: [] }\n`,
    );
    const out = runCli(["graph", "waves", file]);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout).error).toMatchObject({
      code: "WAVES_INCOMPLETE",
      details: { unresolved: ["worker"] },
    });
  });
  test("waves payload carries role and eval verbatim plus advisory warnings", () => {
    const file = join(tmp, "role-eval.yaml");
    writeFileSync(
      file,
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata: { name: role-eval }\ntopology: custom\nnodes:\n  producer:\n    agent: code-reviewer\n    objective: produce\n    evidence: [artifact]\n  gated:\n    agent: code-reviewer\n    objective: gate\n    role: eval-gate\n    depend_on: [producer]\n    eval:\n      prompt: does the artifact hold up?\n      on_fail: revise\n    evidence: []\nevidence: { required_keys: [artifact] }\n`,
    );
    const out = runCli(["graph", "waves", file, "--json"], tmp);
    expect(out.code).toBe(0);
    const data = JSON.parse(out.stdout).data;
    const gated = data.waves
      .flatMap((w: { nodes: Array<{ id: string }> }) => w.nodes)
      .find((n: { id: string }) => n.id === "gated");
    expect(gated.role).toBe("eval-gate");
    expect(gated.eval).toEqual({ prompt: "does the artifact hold up?", on_fail: "revise" });
    // nodes without the fields still surface them as null, verbatim-passthrough contract
    const producer = data.waves
      .flatMap((w: { nodes: Array<{ id: string }> }) => w.nodes)
      .find((n: { id: string }) => n.id === "producer");
    expect(producer.role).toBeNull();
    expect(producer.eval).toBeNull();
    expect(Array.isArray(data.warnings)).toBe(true);
  });
  test("waves ok payload includes advisory warnings for duplicate evidence producers", () => {
    const file = join(tmp, "dupe.yaml");
    writeFileSync(
      file,
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata: { name: dupe }\ntopology: custom\nnodes:\n  a:\n    agent: code-reviewer\n    objective: a\n    evidence: [same.md]\n  b:\n    agent: code-reviewer\n    objective: b\n    depend_on: [a]\n    evidence: [same.md]\nevidence: { required_keys: [same.md] }\n`,
    );
    const out = runCli(["graph", "waves", file, "--json"], tmp);
    expect(out.code).toBe(0);
    const warnings = JSON.parse(out.stdout).data.warnings;
    const producerWarning = warnings.find((w: { check: string }) => w.check === "duplicate-evidence-producer");
    expect(producerWarning.message).toContain("same.md");
    expect(producerWarning.message).toContain("a, b");
  });
  test("validate routes kind GraphTemplate files to the template schema", () => {
    const file = join(tmp, "tpl.yaml");
    writeFileSync(
      file,
      `apiVersion: graphkit.dev/v1\nkind: GraphTemplate\nmetadata: { name: kit, description: d, version: 1 }\nparameters:\n  target:\n    type: string\n    required: true\ngraph:\n  metadata: { name: "inner-{{target}}" }\n  topology: custom\n  nodes:\n    step1: { agent: code-reviewer, objective: "review {{target}}" }\n`,
    );
    const out = runCli(["validate", file, "--json"], tmp);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).data).toEqual({
      valid: true,
      kind: "template",
      name: "kit",
      parameters: { target: { type: "string", required: true } },
      warnings: [],
    });
  });
  test("validate reports template-schema errors, not Graph-schema noise", () => {
    const file = join(tmp, "tpl-bad.yaml");
    writeFileSync(
      file,
      // Original audit fixture used `parameters: {}` — schema-valid (vacuous)
      // under any rule that keeps zero-parameter templates (template init from
      // a static graph) loadable. A bad parameter NAME is the minimal fixture
      // that provably routes through the template schema: GraphSchema would
      // have rejected apiVersion v1 / kind GraphTemplate instead.
      `apiVersion: graphkit.dev/v1\nkind: GraphTemplate\nmetadata: { name: kit, description: d, version: 1 }\nparameters:\n  Bad_Name:\n    description: x\n    required: true\ngraph:\n  metadata: { name: inner }\n  topology: custom\n  nodes:\n    step1: { agent: code-reviewer, objective: x }\n`,
    );
    const out = runCli(["validate", file, "--json"], tmp);
    expect(out.code).toBe(1);
    const err = JSON.parse(out.stdout).error;
    expect(err.code).toBe("SCHEMA_INVALID");
    expect(err.message).toContain("template");
    // GraphSchema would reject apiVersion v1 and kind GraphTemplate — its absence proves routing
    expect(JSON.stringify(err.details.issues)).not.toContain("apiVersion");
  });
  test("validate ok payload carries advisory warnings", () => {
    const file = join(tmp, "advisory.yaml");
    writeFileSync(
      file,
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata: { name: advisory }\ntopology: custom\nnodes:\n  a:\n    agent: code-reviewer\n    objective: a\n    constraints:\n      - source: bogus\n    evidence: []\nevidence: { required_keys: [] }\n`,
    );
    const out = runCli(["validate", file, "--json"], tmp);
    expect(out.code).toBe(0);
    const warnings = JSON.parse(out.stdout).data.warnings;
    expect(warnings.some((w: { check: string }) => w.check === "constraint-source")).toBe(true);
  });
  test("graph waves previews a GraphTemplate in-memory — no SCHEMA_INVALID, no session write", () => {
    const tpl = join(tmp, "preview.gk.yaml");
    writeFileSync(tpl, PREVIEW_TEMPLATE);
    const { stdout, code } = runCli(["graph", "waves", tpl, "--json"], tmp);
    expect(code).toBe(0);
    const data = JSON.parse(stdout).data;
    expect(data.graph).toBe("inner-world");
    expect(data.topology).toBe("custom");
    expect(data.total_nodes).toBe(1);
    expect(data.waves[0].nodes.map((n: { id: string }) => n.id)).toEqual(["step1"]);
    // Preview materializes in-memory: no session graph, no active pointer.
    expect(existsSync(join(tmp, ".graphkit"))).toBe(false);
  });
  test("graph ascii previews a template too", () => {
    const tpl = join(tmp, "preview.gk.yaml");
    writeFileSync(tpl, PREVIEW_TEMPLATE);
    const { stdout, code } = runCli(["graph", "ascii", tpl, "--json"], tmp);
    expect(code).toBe(0);
    expect(stdout).not.toContain("SCHEMA_INVALID");
    expect(stdout).toContain("step1");
  });
  test("validate surfaces embedded-graph agent-binding findings for templates (F10)", () => {
    const tpl = join(tmp, "typo.gk.yaml");
    writeFileSync(tpl, TYPO_TEMPLATE);
    const out = runCli(["validate", tpl, "--json"], tmp);
    expect(out.code).toBe(1);
    const err = JSON.parse(out.stdout).error;
    expect(err.code).toBe("VALIDATION_FAILED");
    const binding = err.details.issues.find((i: { check: string }) => i.check === "agent-binding");
    expect(binding.path).toBe("graph.nodes.step1.agent");
    expect(binding.message).toContain("qa-enginer");
  });
  test("graph waves on a defaults-incomplete template → TEMPLATE_NOT_GRAPH with hint", () => {
    const tpl = join(tmp, "req.gk.yaml");
    writeFileSync(tpl, REQUIRED_PARAM_TEMPLATE);
    const out = runCli(["graph", "waves", tpl, "--json"], tmp);
    expect(out.code).toBe(1);
    const err = JSON.parse(out.stdout).error;
    expect(err.code).toBe("TEMPLATE_NOT_GRAPH");
    expect(err.details.hint).toContain("gk template materialize");
    expect(existsSync(join(tmp, ".graphkit"))).toBe(false);
  });
});
