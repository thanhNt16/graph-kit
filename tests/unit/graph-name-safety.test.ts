// Round 5 A1–A3: graph.metadata.name is agent-authored free text that used to
// reach the filesystem raw — compile/svg/report joined it into output paths
// (traversal), the run id kept it verbatim (a space stranded the ledger: the
// id regex is ^\d{8}-\d{6}-[\w.-]+$), and saveSessionGraph was check-then-write.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { registerEvidenceCommand } from "../../src/cli/commands/evidence.js";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { activeRun, appendNode, endRun, readRunMeta, startRun } from "../../src/memory/ledger.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { safeGraphName, saveSessionGraph } from "../../src/store/index.js";
import { createCliHarness } from "../helpers/cli-harness.js";

const diamondYaml = (name: string) => `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: ${JSON.stringify(name)}
topology: diamond
nodes:
  a:
    agent: software-architect
    objective: o
    depend_on: []
  b:
    agent: code-reviewer
    objective: o
    depend_on: [a]
`;

const evidenceYaml = (name: string) => `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: ${JSON.stringify(name)}
topology: diamond
nodes:
  probe:
    agent: a
    objective: o
    depend_on: []
    evidence: [k]
evidence:
  required_keys: [k]
`;

describe("safeGraphName", () => {
  test("strips everything outside the run-id charset [\\w.-]", () => {
    for (const hostile of ["../../etc/passwd", "My Graph!", "a/b\\c", "..", "  ", "\n\t$x"]) {
      const safe = safeGraphName(hostile);
      expect(safe).toMatch(/^[\w][\w.-]*$/);
      expect(safe).not.toContain("..");
      expect(safe.length).toBeGreaterThan(0);
    }
  });
  test("keeps readable text and falls back on empty", () => {
    expect(safeGraphName("My Graph (v2)")).toBe("My-Graph-v2");
    expect(safeGraphName("...")).toBe("graph");
  });
});

describe("run lifecycle with a hostile display name", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-ns-ledger-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), diamondYaml("My Graph!"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("id always matches the readRunMeta charset; meta.graph keeps the display name", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-13T10:00:00.000Z");
    expect(id).toMatch(/^\d{8}-\d{6}-[\w.-]+$/);
    appendNode(cwd, {
      node: "a",
      wave: 0,
      agent: null,
      model: null,
      status: "ok",
      evidence: [],
      duration_ms: 1,
      notes: null,
    });
    const summary = endRun(cwd, "merged", "2026-09-13T10:01:00.000Z");
    expect(summary.graph).toBe("My Graph!");
    // post-end the run must still resolve (readRunMeta is the resume/list path)
    expect(readRunMeta(cwd, id).graph).toBe("My Graph!");
    expect(readRunIndexHas(cwd, id)).toBe(true);
  });

  test("a failing endRun restores the active pointer instead of stranding the run", () => {
    const { id, dir } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-13T10:00:00.000Z");
    writeFileSync(join(dir, "meta.json"), "{not json");
    expect(() => endRun(cwd, "merged")).toThrow();
    expect(activeRun(cwd)).toBe(dir); // pointer restored — run stays endable/resumable
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        id,
        graph: "My Graph!",
        graph_path: join(cwd, "graph.yaml"),
        graph_sha256: "x",
        started_at: "2026-09-13T10:00:00.000Z",
      }),
    );
    expect(endRun(cwd, "merged").id).toBe(id); // and endable once repaired
  });
});

function readRunIndexHas(cwd: string, id: string): boolean {
  const file = join(cwd, ".graphkit", "runs", "index.jsonl");
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf-8")
    .split("\n")
    .some((l) => l.trim() && JSON.parse(l).id === id);
}

describe("saveSessionGraph exclusive create", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-ns-store-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit"), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const graph = (tag: string) =>
    GraphSchema.parse(
      YAML.parse(`apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: ${tag}\ntopology: diamond\nnodes: {}\n`),
    );

  test("same-slug saves get distinct files; the loser's bytes are never overwritten", () => {
    const first = saveSessionGraph(graph("one"), "slug", cwd);
    const second = saveSessionGraph(graph("two"), "slug", cwd);
    expect(first.id).not.toBe(second.id);
    expect(YAML.parse(readFileSync(first.path, "utf-8")).metadata.name).toBe("one");
  });

  test("concurrent savers each land in their own file (no success pointing at foreign bytes)", async () => {
    const script = `const {saveSessionGraph} = await import(${JSON.stringify(join(import.meta.dir, "..", "..", "src", "store", "index.ts"))});
const r = saveSessionGraph({apiVersion:"graphkit.dev/v2",kind:"Graph",metadata:{name:process.argv[2]},topology:"diamond",nodes:{}}, "race", process.argv[3]);
console.log(r.id);`;
    const scriptPath = join(cwd, "saver.ts");
    writeFileSync(scriptPath, script);
    const procs = ["1", "2", "3", "4", "5", "6"].map((tag) =>
      Bun.spawnSync(["bun", "run", scriptPath, tag, cwd], { stdout: "pipe", stderr: "pipe" }),
    );
    const ids = procs.map((p) => p.stdout.toString().trim());
    expect(new Set(ids).size).toBe(6);
    const dir = join(cwd, ".graphkit", "graphs");
    const files = readdirSync(dir).filter((f) => f.includes("race"));
    expect(files.length).toBe(6);
    for (const f of files) expect(YAML.parse(readFileSync(join(dir, f), "utf-8")).metadata.name).toBeTruthy();
  });
});

describe("graph-name containment at the CLI path sites", () => {
  let tmp: string;
  let parentListing: string[];
  const hostile = "../../gk-esc-probe";
  beforeEach(() => {
    tmp = join(tmpdir(), `gk-ns-cli-${process.pid}-${Date.now()}`);
    mkdirSync(join(tmp, "claude", "agents"), { recursive: true });
    writeFileSync(join(tmp, "claude", "agents", "software-architect.md"), "# SA\n");
    writeFileSync(join(tmp, "claude", "agents", "code-reviewer.md"), "# CR\n");
    writeFileSync(join(tmp, "graph.yaml"), diamondYaml(hostile));
    mkdirSync(join(tmp, ".graphkit"), { recursive: true });
    mkdirSync(join(tmp, ".claude", "workflows"), { recursive: true });
    parentListing = safeReaddir(tmp);
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(tmp, { recursive: true, force: true });
  });

  function assertContained(sub: string, pattern: RegExp) {
    const entries = readdirSync(join(tmp, sub));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).toMatch(pattern);
    expect(safeReaddir(tmp)).toEqual(parentListing); // nothing escaped the project
  }

  test("compile", async () => {
    const run = await createCliHarness(registerGraphCommands, { cwd: tmp }).runAsync(
      ["compile", join(tmp, "graph.yaml")],
      500,
    );
    expect(run.stdout).toContain("compiled");
    assertContained(join(".claude", "workflows"), /^[\w.-]+\.workflow\.js$/);
  });

  test("graph svg", async () => {
    const run = await createCliHarness(registerGraphCommands, { cwd: tmp }).runAsync(["graph", "svg", "graph.yaml"]);
    expect(run.stdout).toContain(".svg");
    assertContained(join(".graphkit", "diagrams"), /^[\w.-]+\.svg$/);
  });

  test("evidence report --html", async () => {
    writeFileSync(join(tmp, "graph.yaml"), evidenceYaml(hostile));
    mkdirSync(join(tmp, ".graphkit", "evidence"), { recursive: true });
    const run = await createCliHarness(registerEvidenceCommand, { cwd: tmp }).runAsync([
      "evidence",
      "report",
      "--html",
    ]);
    expect(run.stdout).toContain("wrote");
    assertContained(join(".graphkit", "reports"), /^[\w.-]+-evidence\.html$/);
  });
});

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
