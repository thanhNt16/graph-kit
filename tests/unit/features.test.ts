import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerFeaturesCommand } from "../../src/cli/commands/features.js";
import { gateGraph, registerGateCommand } from "../../src/cli/commands/gate.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { GraphKitError } from "../../src/errors.js";
import {
  addFeature,
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

  test("add appends an open item at the tail; next stays deterministic (insertion order)", () => {
    const path = featureListPath(tmp);
    initFeatureList(path, TWO_ITEMS);
    const { item } = addFeature(path, { description: "Gamma item", evidence: "gamma-proof" });
    expect(item.id).toBe("gamma-item");
    expect(item.passes).toBe(false);
    expect(item.evidence).toBe("gamma-proof");
    expect(readFeatureList(path).items.map((i) => i.id)).toEqual(["a", "b", "gamma-item"]);
    // appended items join the back of the priority queue — next() never re-ranks
    expect(nextFeature(readFeatureList(path))?.id).toBe("a");
    passFeature(path, "a");
    expect(nextFeature(readFeatureList(path))?.id).toBe("b");
    passFeature(path, "b");
    expect(nextFeature(readFeatureList(path))?.id).toBe("gamma-item");
  });

  test("add rejects an explicit id that already exists with FEATURE_EXISTS", () => {
    const path = featureListPath(tmp);
    initFeatureList(path, TWO_ITEMS);
    try {
      addFeature(path, { id: "a", description: "duplicate" });
      expect.unreachable();
    } catch (e) {
      expect((e as GraphKitError).code).toBe("FEATURE_EXISTS");
    }
    expect(readFeatureList(path).items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  test("add derives a slug id from the description, suffixed on collision", () => {
    const path = featureListPath(tmp);
    initFeatureList(path, TWO_ITEMS);
    const first = addFeature(path, { description: "Ship the UI!" });
    const second = addFeature(path, { description: "ship the ui" });
    expect(first.item.id).toBe("ship-the-ui");
    expect(second.item.id).toBe("ship-the-ui-2");
  });

  test("add + pass share the lock: interleaved writes stay consistent, no lock residue", () => {
    const path = featureListPath(tmp);
    initFeatureList(path, TWO_ITEMS);
    addFeature(path, { description: "third" });
    passFeature(path, "a");
    addFeature(path, { description: "fourth" });
    passFeature(path, "third");
    const list = readFeatureList(path);
    expect(list.items.map((i) => `${i.id}:${i.passes}`)).toEqual(["a:true", "b:false", "third:true", "fourth:false"]);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("add reclaims a stale lock instead of bricking the backlog", () => {
    const path = featureListPath(tmp);
    initFeatureList(path, TWO_ITEMS);
    mkdirSync(`${path}.lock`);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, stale, stale);
    const { item } = addFeature(path, { description: "reclaimed" });
    expect(item.id).toBe("reclaimed");
    expect(existsSync(`${path}.lock`)).toBe(false);
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

  test("add via CLI: derived slug, --evidence stored, open item reaches next", () => {
    runCli(["features", "init"], tmp);
    const add = runCli(["features", "add", "--description", "User can export CSV", "--evidence", "export-csv"], tmp);
    expect(add.code).toBe(0);
    const addJson = JSON.parse(add.stdout);
    expect(addJson.data.item.id).toBe("user-can-export-csv");
    expect(addJson.data.item.passes).toBe(false);
    expect(addJson.data.item.evidence).toBe("export-csv");
    expect(addJson.data).toMatchObject({ total: 1, done: 0, open: 1 });
    const next = JSON.parse(runCli(["features", "next"], tmp).stdout);
    expect(next.data.item.id).toBe("user-can-export-csv");
  });

  test("add via CLI: explicit --id, duplicate --id fails FEATURE_EXISTS", () => {
    runCli(["features", "init"], tmp);
    const add = runCli(["features", "add", "--id", "billing", "--description", "Billing page"], tmp);
    expect(add.code).toBe(0);
    expect(JSON.parse(add.stdout).data.item.id).toBe("billing");
    const dup = runCli(["features", "add", "--id", "billing", "--description", "Billing again"], tmp);
    expect(dup.code).toBe(1);
    expect(JSON.parse(dup.stdout).error.code).toBe("FEATURE_EXISTS");
  });

  test("add via CLI: missing --description fails MISSING_ARG", () => {
    runCli(["features", "init"], tmp);
    const r = runCli(["features", "add"], tmp);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("MISSING_ARG");
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
