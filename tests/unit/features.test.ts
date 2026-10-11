import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerFeaturesCommand } from "../../src/cli/commands/features.js";
import { gateGraph, registerGateCommand } from "../../src/cli/commands/gate.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { GraphKitError } from "../../src/errors.js";
import {
  featureListPath,
  featureStatus,
  initFeatureList,
  nextFeature,
  passFeature,
  readFeatureList,
  seedFromGraph,
  writeFeatureList,
} from "../../src/features/store.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

function scaffoldProject(dir: string) {
  mkdirSync(join(dir, ".omp", "agents"), { recursive: true });
  writeFileSync(join(dir, ".omp", "agents", "software-architect.md"), "# SA\n");
  writeFileSync(join(dir, ".omp", "agents", "code-reviewer.md"), "# CR\n");
}

function runCli(args: string[], cwd: string) {
  const origCwd = process.cwd();
  process.chdir(cwd);
  const cli = cac("gk");
  registerFeaturesCommand(cli);
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

function parseGraph(yamlDoc: Record<string, unknown>) {
  const parsed = GraphSchema.safeParse(yamlDoc);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

const TWO_ITEMS = [
  { id: "a", description: "first", passes: false },
  { id: "b", description: "second", passes: false },
];

describe("feature store", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `gk-features-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("roundtrip: init writes the file, read restores items in declared order", () => {
    const path = featureListPath(tmp);
    initFeatureList(path, [
      { id: "a", description: "alpha", steps: ["s1"], passes: false },
      { id: "b", description: "beta", category: "ui", steps: [], passes: true },
    ]);
    const list = readFeatureList(path);
    expect(list.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(list.items[0].steps).toEqual(["s1"]);
    expect(list.items[1].category).toBe("ui");
    expect(list.items[1].passes).toBe(true);
  });

  test("writes are atomic: no tmp sibling survives a committed write", () => {
    const path = featureListPath(tmp);
    writeFeatureList(path, { items: TWO_ITEMS });
    const leftovers = readdirSync(join(tmp, ".graphkit")).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("init refuses to clobber an existing list without force", () => {
    const path = featureListPath(tmp);
    initFeatureList(path, TWO_ITEMS);
    expect(() => initFeatureList(path, [])).toThrow(GraphKitError);
    try {
      initFeatureList(path, []);
    } catch (e) {
      expect((e as GraphKitError).code).toBe("FEATURE_LIST_EXISTS");
    }
    initFeatureList(path, [], { force: true });
    expect(readFeatureList(path).items).toEqual([]);
  });

  test("next returns the first passes:false item in declared order", () => {
    const list = {
      items: [
        { id: "done", description: "x", steps: [], passes: true },
        { id: "next-up", description: "y", steps: [], passes: false },
        { id: "later", description: "z", steps: [], passes: false },
      ],
    };
    expect(nextFeature(list)?.id).toBe("next-up");
  });

  test("pass flips the flag, is idempotent, and records a note", () => {
    const path = featureListPath(tmp);
    initFeatureList(path, TWO_ITEMS);
    const first = passFeature(path, "a", "shipped in abc123");
    expect(first.already_passed).toBe(false);
    expect(readFeatureList(path).items[0].passes).toBe(true);
    const second = passFeature(path, "a");
    expect(second.already_passed).toBe(true);
    expect(readFeatureList(path).items[0].note).toBe("shipped in abc123");
    expect(featureStatus(readFeatureList(path))).toEqual({ total: 2, done: 1, open: 1 });
  });

  test("pass on unknown id fails FEATURE_ITEM_NOT_FOUND", () => {
    const path = featureListPath(tmp);
    initFeatureList(path, TWO_ITEMS);
    try {
      passFeature(path, "nope");
      expect.unreachable();
    } catch (e) {
      expect((e as GraphKitError).code).toBe("FEATURE_ITEM_NOT_FOUND");
    }
  });

  test("missing file fails FEATURE_LIST_MISSING; bad JSON fails FEATURE_LIST_INVALID", () => {
    const path = featureListPath(tmp);
    try {
      readFeatureList(path);
      expect.unreachable();
    } catch (e) {
      expect((e as GraphKitError).code).toBe("FEATURE_LIST_MISSING");
    }
    mkdirSync(join(tmp, ".graphkit"), { recursive: true });
    writeFileSync(path, "{not json");
    try {
      readFeatureList(path);
      expect.unreachable();
    } catch (e) {
      expect((e as GraphKitError).code).toBe("FEATURE_LIST_INVALID");
    }
  });

  test("duplicate ids are rejected as FEATURE_LIST_INVALID", () => {
    const path = featureListPath(tmp);
    mkdirSync(join(tmp, ".graphkit"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        items: [
          { id: "a", description: "x", passes: false },
          { id: "a", description: "y" },
        ],
      }),
    );
    try {
      readFeatureList(path);
      expect.unreachable();
    } catch (e) {
      expect((e as GraphKitError).code).toBe("FEATURE_LIST_INVALID");
    }
  });

  test("seedFromGraph seeds items from array-typed input defaults", () => {
    const graph = parseGraph({
      metadata: { name: "t" },
      topology: "diamond",
      inputs: {
        task: { type: "string", required: true },
        backlog: { type: "array", default: ["Build login page", { id: "api", description: "Wire API" }] },
      },
      nodes: {},
    });
    const items = seedFromGraph(graph);
    expect(items.map((i) => i.id)).toEqual(["build-login-page", "api"]);
    expect(items.every((i) => i.passes === false)).toBe(true);
  });
});

describe("features schema + validation", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `gk-features-val-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    scaffoldProject(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const baseDoc = {
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "t" },
    topology: "diamond",
    nodes: {
      init: { agent: "software-architect", objective: "write the list", depend_on: [] },
      worker: { agent: "code-reviewer", objective: "work", depend_on: ["init"] },
    },
  };

  test("features.required without an initializer-role node warns (advisory)", () => {
    const graph = parseGraph({ ...baseDoc, features: { required: true } });
    const f = validateGraph(graph, tmp).find((x) => x.check === "features-producer");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warn");
  });

  test("role: initializer is recognized — no unknown-role warning, no producer warning", () => {
    const doc = {
      ...baseDoc,
      features: { required: true },
      nodes: {
        ...baseDoc.nodes,
        init: { ...baseDoc.nodes.init, role: "initializer" },
      },
    };
    const graph = parseGraph(doc);
    const findings = validateGraph(graph, tmp);
    expect(findings.find((f) => f.check === "features-producer")).toBeUndefined();
    expect(findings.find((f) => f.check === "unknown-role" && f.path === "nodes.init.role")).toBeUndefined();
  });

  test("unrecognized roles still warn", () => {
    const doc = { ...baseDoc, nodes: { ...baseDoc.nodes, worker: { ...baseDoc.nodes.worker, role: "boss" } } };
    const graph = parseGraph(doc);
    const f = validateGraph(graph, tmp).find((x) => x.check === "unknown-role");
    expect(f?.severity).toBe("warn");
  });

  test("features block is optional and strict", () => {
    expect(GraphSchema.safeParse({ ...baseDoc }).success).toBe(true);
    expect(GraphSchema.safeParse({ ...baseDoc, features: { required: true, bogus: 1 } }).success).toBe(false);
    // old graphs without the block still validate — backward compatibility
    expect(GraphSchema.safeParse({ ...baseDoc, features: { required: true, path: "custom/list.json" } }).success).toBe(
      true,
    );
  });
});

describe("gate + features.required", () => {
  let tmp: string;
  let evDir: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `gk-features-gate-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    scaffoldProject(tmp);
    evDir = join(tmp, ".graphkit", "evidence");
    mkdirSync(evDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const gate = () => gateGraph(["design"], evDir, { cwd: tmp, features: { required: true } });

  test("missing feature list BLOCKs with FEATURE_LIST_MISSING", () => {
    writeFileSync(join(evDir, "design.md"), "approved\n");
    const r = gate();
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons).toContain("FEATURE_LIST_MISSING");
    expect(r.features?.state).toBe("missing");
  });

  test("open items BLOCK with FEATURES_OPEN:n; all-passed MERGEs", () => {
    writeFileSync(join(evDir, "design.md"), "approved\n");
    initFeatureList(featureListPath(tmp), TWO_ITEMS);
    const blocked = gate();
    expect(blocked.verdict).toBe("BLOCK");
    expect(blocked.reasons).toContain("FEATURES_OPEN:2");
    expect(blocked.features?.open_items).toEqual(["a", "b"]);
    passFeature(featureListPath(tmp), "a");
    const stillBlocked = gate();
    expect(stillBlocked.verdict).toBe("BLOCK");
    expect(stillBlocked.reasons).toContain("FEATURES_OPEN:1");
    passFeature(featureListPath(tmp), "b");
    const merged = gate();
    expect(merged.verdict).toBe("MERGE");
    expect(merged.features?.open).toBe(0);
  });

  test("features.required: false never engages the feature gate", () => {
    writeFileSync(join(evDir, "design.md"), "approved\n");
    const r = gateGraph(["design"], evDir, { cwd: tmp, features: { required: false } });
    expect(r.verdict).toBe("MERGE");
    expect(r.features).toBeUndefined();
    expect(r.reasons).toEqual([]);
  });

  test("gk gate end-to-end: BLOCK → pass items → MERGE", () => {
    writeFileSync(
      join(tmp, "graph.yaml"),
      `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
nodes:
  init:
    agent: software-architect
    objective: write the list
    role: initializer
    depend_on: []
  worker:
    agent: code-reviewer
    objective: work
    depend_on: [init]
    evidence: [design]
evidence:
  required_keys: [design]
features:
  required: true
`,
    );
    writeFileSync(join(evDir, "design.md"), "approved\n");
    initFeatureList(featureListPath(tmp), TWO_ITEMS);
    const blocked = runCli(["gate"], tmp);
    expect(blocked.code).toBe(1);
    const blockedJson = JSON.parse(blocked.stdout);
    expect(blockedJson.error.code).toBe("GATE_BLOCK");
    expect(blockedJson.error.details.reasons).toContain("FEATURES_OPEN:2");
    expect(blockedJson.error.details.features.open_items).toEqual(["a", "b"]);
    passFeature(featureListPath(tmp), "a");
    passFeature(featureListPath(tmp), "b");
    const merged = runCli(["gate"], tmp);
    expect(merged.code).toBe(0);
    const mergedJson = JSON.parse(merged.stdout);
    expect(mergedJson.data.verdict).toBe("MERGE");
    expect(mergedJson.data.features.open).toBe(0);
  });
});

describe("gk features CLI", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `gk-features-cli-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    scaffoldProject(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("init → next → pass → status: full loop over the CLI surface", () => {
    writeFileSync(
      join(tmp, "graph.yaml"),
      `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
inputs:
  backlog:
    type: array
    default: [Alpha feature, Beta feature]
nodes:
  init:
    agent: software-architect
    objective: write the list
    role: initializer
    depend_on: []
features:
  required: true
`,
    );
    const init = runCli(["features", "init"], tmp);
    expect(init.code).toBe(0);
    const initJson = JSON.parse(init.stdout);
    expect(initJson.data.seeded).toBe(2);
    expect(initJson.data.list.items[0].passes).toBe(false);

    const next1 = JSON.parse(runCli(["features", "next"], tmp).stdout);
    expect(next1.data.item.id).toBe("alpha-feature");

    const pass = JSON.parse(runCli(["features", "pass", "alpha-feature", "--note", "done"], tmp).stdout);
    expect(pass.status).toBe("ok");
    expect(pass.data.item.passes).toBe(true);
    expect(pass.data.item.note).toBe("done");

    const status = JSON.parse(runCli(["features", "status"], tmp).stdout);
    expect(status.data).toMatchObject({ total: 2, done: 1, open: 1 });

    JSON.parse(runCli(["features", "pass", "beta-feature"], tmp).stdout);
    const next2 = JSON.parse(runCli(["features", "next"], tmp).stdout);
    expect(next2.data.item).toBeNull();
    expect(next2.data.done).toBe(true);
  });

  test("features commands work with no graph resolvable (default store path)", () => {
    const init = runCli(["features", "init"], tmp);
    expect(init.code).toBe(0);
    expect(existsSync(join(tmp, ".graphkit", "feature-list.json"))).toBe(true);
  });

  test("unknown subcommand fails UNKNOWN_FEATURES_SUBCOMMAND", () => {
    const r = runCli(["features", "bogus"], tmp);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("UNKNOWN_FEATURES_SUBCOMMAND");
  });

  test("pass on missing list fails FEATURE_LIST_MISSING", () => {
    const r = runCli(["features", "pass", "a"], tmp);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("FEATURE_LIST_MISSING");
  });

  test("init on existing list fails FEATURE_LIST_EXISTS", () => {
    runCli(["features", "init"], tmp);
    const r = runCli(["features", "init"], tmp);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("FEATURE_LIST_EXISTS");
  });
});
