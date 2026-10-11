import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import YAML from "yaml";
import { gateGraph, registerGateCommand } from "../../src/cli/commands/gate.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { buildViews, renderMarkdown, scoreViews } from "../../src/evidence/report.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

function scaffoldProject(dir: string) {
  mkdirSync(join(dir, ".omp", "agents"), { recursive: true });
  writeFileSync(join(dir, ".omp", "agents", "software-architect.md"), "# SA\n");
}

function runCli(args: string[], cwd: string) {
  const origCwd = process.cwd();
  process.chdir(cwd);
  const cli = cac("gk");
  registerGateCommand(cli);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let exitCode = 0;
  let code = 0;
  const origExit = process.exit;
  process.exit = (c?: number) => {
    exitCode = c ?? 1;
  };
  let error: Error | undefined;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } catch (e) {
    error = e as Error;
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.chdir(origCwd);
    code = exitCode || ((process.exitCode as number | undefined) ?? 0);
    process.exitCode = 0;
  }
  return { stdout: logs.join("\n"), code, error };
}

const SCORED_GRAPH = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: test-scored
topology: diamond
nodes:
  scouter:
    agent: software-architect
    objective: test
    depend_on: []
    evidence: [design, tests, docs]
evidence:
  required_keys: [design]
  verdict: scored
  threshold: 0.7
  criteria:
    - { id: design, weight: 2 }
    - { id: tests, weight: 1 }
    - { id: docs, weight: 1 }
`;

function graphObj(ev: unknown) {
  return YAML.parse(
    YAML.stringify({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "t" },
      topology: "diamond",
      nodes: { probe: { agent: "a", objective: "o", depend_on: [], evidence: ["a", "b"] } },
      evidence: ev,
    }),
  );
}
function parseGraph(ev: unknown) {
  return GraphSchema.parse(graphObj(ev));
}

describe("scored gate — schema + validation", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-scored-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, "criteria"), { recursive: true });
    for (const id of ["a", "b"]) writeFileSync(join(cwd, "criteria", `${id}.md`), `desc ${id}\n`);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("criteria accepts strings and {id, weight}; verdict/threshold parse", () => {
    const g = parseGraph({
      required_keys: ["a"],
      verdict: "scored",
      threshold: 0.7,
      criteria: ["a", { id: "b", weight: 2 }],
    });
    expect(g.evidence.verdict).toBe("scored");
    expect(g.evidence.threshold).toBe(0.7);
    expect(g.evidence.criteria).toEqual(["a", { id: "b", weight: 2 }]);
    // default stays binary
    expect(parseGraph({ required_keys: ["a"] }).evidence.verdict).toBe("binary");
    // threshold range enforced at schema
    expect(GraphSchema.safeParse(graphObj({ required_keys: ["a"], threshold: 1.5 })).success).toBe(false);
    // weighted entry requires weight
    expect(GraphSchema.safeParse(graphObj({ required_keys: ["a"], criteria: [{ id: "a" }] })).success).toBe(false);
  });

  test("scored without threshold → scored-threshold finding", () => {
    const g = parseGraph({ required_keys: ["a"], verdict: "scored", criteria: ["a"] });
    expect(validateGraph(g, cwd).some((f) => f.check === "scored-threshold" && f.severity !== "warn")).toBe(true);
  });

  test("scored with no criteria → scored-criteria finding", () => {
    const g = parseGraph({ required_keys: ["a"], verdict: "scored", threshold: 0.5 });
    expect(validateGraph(g, cwd).some((f) => f.check === "scored-criteria" && f.severity !== "warn")).toBe(true);
  });

  test("non-positive weight → criteria-weight finding", () => {
    for (const weight of [0, -1]) {
      const g = parseGraph({
        required_keys: ["a"],
        verdict: "scored",
        threshold: 0.5,
        criteria: [{ id: "a", weight }],
      });
      const fs = validateGraph(g, cwd);
      expect(fs.some((f) => f.check === "criteria-weight" && f.severity !== "warn")).toBe(true);
    }
  });

  test("threshold without scored → advisory only, does not block", () => {
    const g = parseGraph({ required_keys: ["a"], threshold: 0.5, criteria: ["a"] });
    const fs = validateGraph(g, cwd);
    const hit = fs.find((f) => f.check === "scored-threshold");
    expect(hit?.severity).toBe("warn");
    expect(fs.filter((f) => f.severity !== "warn")).toEqual([]);
  });

  test("weighted criteria under binary verdict → advisory only", () => {
    const g = parseGraph({ required_keys: ["a"], criteria: [{ id: "a", weight: 2 }] });
    const fs = validateGraph(g, cwd);
    expect(fs.some((f) => f.check === "scored-weight" && f.severity === "warn")).toBe(true);
    expect(fs.filter((f) => f.severity !== "warn")).toEqual([]);
  });
});

describe("scored gate — gateGraph", () => {
  let evDir: string;
  beforeEach(() => {
    evDir = join(tmpdir(), `gk-scored-gate-${process.pid}-${Date.now()}`);
    mkdirSync(evDir, { recursive: true });
  });
  afterEach(() => rmSync(evDir, { recursive: true, force: true }));

  const scored = (criteria: { id: string; weight: number }[], threshold = 0.7) => ({
    criteria,
    threshold,
  });

  test("weighted math: all pass → 1.00 MERGE; partial → weight fraction", () => {
    writeFileSync(join(evDir, "a.md"), "ok\n");
    writeFileSync(join(evDir, "b.md"), "ok\n");
    const all = gateGraph(["a", "b"], evDir, {
      scored: scored([
        { id: "a", weight: 2 },
        { id: "b", weight: 1 },
      ]),
    });
    expect(all.verdict).toBe("MERGE");
    expect(all.score).toBeCloseTo(1, 5);
    expect(all.per_criterion?.map((c) => c.contribution)).toEqual([2, 1]);

    rmSync(join(evDir, "b.md"));
    const partial = gateGraph(["a", "b"], evDir, {
      scored: scored([
        { id: "a", weight: 2 },
        { id: "b", weight: 1 },
      ]),
    });
    expect(partial.score).toBeCloseTo(2 / 3, 5);
    expect(partial.verdict).toBe("BLOCK"); // 0.67 < 0.7
    expect(partial.per_criterion?.find((c) => c.id === "b")).toMatchObject({ passed: false, contribution: 0 });
  });

  test("score == threshold merges (>= boundary)", () => {
    writeFileSync(join(evDir, "a.md"), "ok\n");
    const r = gateGraph([], evDir, {
      scored: scored(
        [
          { id: "a", weight: 3 },
          { id: "b", weight: 1 },
        ],
        0.75,
      ),
    });
    expect(r.score).toBeCloseTo(0.75, 5);
    expect(r.verdict).toBe("MERGE");
  });

  test("missing criterion contributes 0 to numerator, keeps denominator", () => {
    writeFileSync(join(evDir, "a.md"), "ok\n");
    const r = gateGraph([], evDir, {
      scored: scored(
        [
          { id: "a", weight: 1 },
          { id: "b", weight: 3 },
        ],
        0.5,
      ),
    });
    expect(r.score).toBeCloseTo(0.25, 5);
    expect(r.verdict).toBe("BLOCK");
  });

  test("required_keys stay a hard floor even when the score passes", () => {
    writeFileSync(join(evDir, "a.md"), "ok\n");
    // required key "req" missing; criteria all pass → floor still blocks
    const r = gateGraph(["req"], evDir, { scored: scored([{ id: "a", weight: 1 }], 0.5) });
    expect(r.score).toBeCloseTo(1, 5);
    expect(r.verdict).toBe("BLOCK");
    expect(r.missing).toContain("req");
  });

  test("binary mode ignores scored opts fields entirely (no score emitted)", () => {
    writeFileSync(join(evDir, "a.md"), "ok\n");
    const r = gateGraph(["a"], evDir);
    expect(r.verdict).toBe("MERGE");
    expect(r.score).toBeUndefined();
    expect(r.per_criterion).toBeUndefined();
    expect(r.threshold).toBeUndefined();
  });
});

describe("gk gate — scored CLI", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = join(tmpdir(), `gk-scored-cmd-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    scaffoldProject(tmp);
    mkdirSync(join(tmp, "criteria"), { recursive: true });
    for (const id of ["design", "tests", "docs"]) writeFileSync(join(tmp, "criteria", `${id}.md`), `${id} rubric\n`);
    writeFileSync(join(tmp, "graph.yaml"), SCORED_GRAPH);
    mkdirSync(join(tmp, ".graphkit", "evidence"), { recursive: true });
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(tmp, { recursive: true, force: true });
  });

  const ev = (id: string) => join(tmp, ".graphkit", "evidence", `${id}.md`);

  test("merge path emits score/threshold/per_criterion/summary, exit 0", () => {
    writeFileSync(ev("design"), "approved\n");
    writeFileSync(ev("tests"), "green\n");
    writeFileSync(ev("docs"), "written\n");
    const r = runCli(["gate", join(tmp, "graph.yaml")], tmp);
    expect(r.code).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.status).toBe("ok");
    expect(p.data.verdict).toBe("MERGE");
    expect(p.data.score).toBeCloseTo(1, 5);
    expect(p.data.threshold).toBe(0.7);
    expect(p.data.per_criterion).toHaveLength(3);
    expect(p.data.summary).toBe("SCORE 1.00 >= 0.70 → MERGE");
  });

  test("block path: score below threshold exits 1 with per-criterion table", () => {
    writeFileSync(ev("design"), "approved\n");
    writeFileSync(ev("tests"), "green\n");
    // docs missing → score (2+1)/4 = 0.75 ≥ 0.7? design(2)+tests(1)=3/4=0.75 → MERGE
    const pass = runCli(["gate", join(tmp, "graph.yaml")], tmp);
    expect(pass.code).toBe(0);
    expect(JSON.parse(pass.stdout).data.score).toBeCloseTo(0.75, 5);

    rmSync(ev("tests"));
    // now only design → 2/4 = 0.5 < 0.7 → BLOCK
    const block = runCli(["gate", join(tmp, "graph.yaml")], tmp);
    expect(block.code).toBe(1);
    const p = JSON.parse(block.stdout);
    expect(p.status).toBe("fail");
    expect(p.error.code).toBe("GATE_BLOCK");
    expect(p.error.details.score).toBeCloseTo(0.5, 5);
    expect(p.error.details.threshold).toBe(0.7);
    expect(p.error.details.per_criterion.map((c: { id: string }) => c.id)).toEqual(["design", "tests", "docs"]);
    expect(p.error.details.summary).toBe("SCORE 0.50 < 0.70 → BLOCK");
  });

  test("scored gate with missing threshold → VALIDATION_FAILED", () => {
    writeFileSync(join(tmp, "graph.yaml"), SCORED_GRAPH.replace("  threshold: 0.7\n", ""));
    const r = runCli(["gate", join(tmp, "graph.yaml")], tmp);
    expect(r.code).toBe(1);
    const p = JSON.parse(r.stdout);
    expect(p.error.code).toBe("VALIDATION_FAILED");
    expect(p.error.details.issues.some((i: { check: string }) => i.check === "scored-threshold")).toBe(true);
  });

  test("mixed string/object criteria list scores strings as weight 1", () => {
    writeFileSync(
      join(tmp, "graph.yaml"),
      SCORED_GRAPH.replace(
        "    - { id: design, weight: 2 }\n    - { id: tests, weight: 1 }\n    - { id: docs, weight: 1 }",
        "    - design\n    - { id: tests, weight: 3 }",
      ),
    );
    writeFileSync(join(tmp, "criteria", "design.md"), "design rubric\n");
    writeFileSync(ev("design"), "approved\n");
    writeFileSync(ev("tests"), "green\n");
    const r = runCli(["gate", join(tmp, "graph.yaml")], tmp);
    expect(r.code).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.data.per_criterion).toEqual([
      expect.objectContaining({ id: "design", weight: 1, passed: true, contribution: 1 }),
      expect.objectContaining({ id: "tests", weight: 3, passed: true, contribution: 3 }),
    ]);
    expect(p.data.score).toBeCloseTo(1, 5);
  });

  test("binary default unchanged: same files, no score fields in payload", () => {
    writeFileSync(
      join(tmp, "graph.yaml"),
      `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: test-binary
topology: diamond
nodes:
  scouter:
    agent: software-architect
    objective: test
    depend_on: []
    evidence: [design]
evidence:
  required_keys: [design]
`,
    );
    writeFileSync(ev("design"), "approved\n");
    const r = runCli(["gate", join(tmp, "graph.yaml")], tmp);
    expect(r.code).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.data.verdict).toBe("MERGE");
    expect("score" in p.data).toBe(false);
    expect("per_criterion" in p.data).toBe(false);
  });
});

describe("scored gate — evidence report", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-scored-rep-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    mkdirSync(join(cwd, "criteria"), { recursive: true });
    writeFileSync(join(cwd, "criteria", "a.md"), "rubric a\n");
    writeFileSync(join(cwd, "criteria", "b.md"), "rubric b\n");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const scoredGraph = () =>
    GraphSchema.parse(
      YAML.parse(`apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
nodes:
  probe:
    agent: a
    objective: o
    depend_on: []
    evidence: [a, b]
evidence:
  required_keys: [a]
  verdict: scored
  threshold: 0.6
  criteria:
    - { id: a, weight: 2 }
    - { id: b, weight: 1 }
`),
    );

  test("scoreViews null under binary; scored view lists criteria incl. non-required", () => {
    writeFileSync(join(cwd, ".graphkit", "evidence", "a.md"), "ok\n");
    writeFileSync(join(cwd, ".graphkit", "evidence", "b.md"), "ok\n");
    const g = scoredGraph();
    const views = buildViews(cwd, g);
    expect(views.map((v) => v.id)).toEqual(["a", "b"]); // union: b is produced, not required
    const s = scoreViews(g, views);
    expect(s).not.toBeNull();
    expect(s?.score).toBeCloseTo(1, 5);
    expect(s?.verdict).toBe("MERGE");

    const binary = GraphSchema.parse(
      YAML.parse(`apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
nodes:
  probe: { agent: a, objective: o, depend_on: [], evidence: [a] }
evidence:
  required_keys: [a]
`),
    );
    expect(scoreViews(binary, buildViews(cwd, binary))).toBeNull();
  });

  test("markdown report carries the gate-score table", () => {
    writeFileSync(join(cwd, ".graphkit", "evidence", "a.md"), "ok\n");
    const g = scoredGraph();
    const views = buildViews(cwd, g);
    const s = scoreViews(g, views);
    expect(s?.score).toBeCloseTo(2 / 3, 5);
    expect(s?.verdict).toBe("MERGE"); // 0.67 >= 0.6
    const md = renderMarkdown("t", views, s);
    expect(md).toContain("Gate score");
    expect(md).toContain("SCORE 0.67 >= 0.60 → MERGE");
    expect(md).toContain("| b | 1 | fail | 0 |");
  });
});
