import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

function runCli(args: string[]) {
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
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.exit = origExit;
  }
  return { stdout: logs.join("\n"), code: exitCode };
}

const ON_NODE = join(tmpdir(), `gk-waves-mem-on-${process.pid}-${Date.now()}.yaml`);
const EVERY2 = join(tmpdir(), `gk-waves-mem-every-${process.pid}-${Date.now()}.yaml`);
const NO_CURATOR = join(tmpdir(), `gk-waves-mem-nocur-${process.pid}-${Date.now()}.yaml`);

writeFileSync(
  ON_NODE,
  `topology: memory-augmented
topology_config:
  memory: { curator_node: curator, cadence: on_node_complete }
nodes:
  scouter: { agent: Software Architect, depend_on: [] }
  worker: { agent: Code Reviewer, depend_on: [scouter] }
  synthesizer: { agent: Software Architect, depend_on: [worker] }
  curator: { agent: Memory Curator, depend_on: [] }
`,
);

writeFileSync(
  EVERY2,
  `topology: memory-augmented
topology_config:
  memory: { curator_node: curator, cadence: every, every: 2 }
nodes:
  scouter: { agent: Software Architect, depend_on: [] }
  worker: { agent: Code Reviewer, depend_on: [scouter] }
  synthesizer: { agent: Software Architect, depend_on: [worker] }
  curator: { agent: Memory Curator, depend_on: [] }
`,
);

writeFileSync(
  NO_CURATOR,
  `topology: memory-augmented
topology_config:
  memory: { curator_node: curator, cadence: on_node_complete }
nodes:
  scouter: { agent: Software Architect, depend_on: [] }
  synthesizer: { agent: Software Architect, depend_on: [scouter] }
`,
);

function parsed(file: string) {
  const { stdout, code } = runCli(["graph", "waves", file, "--json"]);
  expect(code).toBe(0);
  return JSON.parse(stdout).data;
}

describe("gk graph waves — memory-augmented curator interleave", () => {
  test("curator excluded from action waves; interleaved at on_node_complete cadence", () => {
    const d = parsed(ON_NODE);
    // 3 action waves + a curator after each (last wave already curated → no extra final)
    expect(d.total_waves).toBe(6);
    const curatorWaves = d.waves.filter((w: { curator?: boolean }) => w.curator === true);
    expect(curatorWaves.length).toBe(3);
    // curator waves sit between action waves, not alongside them
    expect(d.waves[1].curator).toBe(true);
    expect(d.waves[3].curator).toBe(true);
    expect(d.waves[5].curator).toBe(true);
    expect(d.waves[0].curator).toBeUndefined();
    // action waves never contain the curator node
    for (const w of d.waves) {
      if (!w.curator) expect(w.nodes.map((n: { id: string }) => n.id)).not.toContain("curator");
    }
  });

  test("curator wave carries gk-recall skill + curator:true marker", () => {
    const d = parsed(ON_NODE);
    const cw = d.waves.find((w: { curator?: boolean }) => w.curator === true);
    expect(cw.parallel).toBe(false);
    expect(cw.nodes[0].id).toBe("curator");
    expect(cw.nodes[0].skills).toContain("gk-recall");
  });

  test("cadence 'every: 2' fires curator after wave 2 and at end (no duplicate)", () => {
    const d = parsed(EVERY2);
    // 3 action waves; curator after wave 2 + a final (last wave 3 didn't curate)
    expect(d.total_waves).toBe(5);
    const curatorIdxs = d.waves
      .map((w: { curator?: boolean }, i: number) => (w.curator ? i : -1))
      .filter((i: number) => i >= 0);
    expect(curatorIdxs).toEqual([2, 4]);
  });

  test("no interleave when curator node is absent (graceful)", () => {
    const d = parsed(NO_CURATOR);
    expect(d.memory).toBeUndefined();
    expect(d.waves.some((w: { curator?: boolean }) => w.curator === true)).toBe(false);
    expect(d.total_waves).toBe(2); // scouter → synthesizer
  });

  test("envelope carries memory config", () => {
    const d = parsed(ON_NODE);
    expect(d.memory).toEqual({ curator_node: "curator", cadence: "on_node_complete", every: 1 });
    expect(d.topology).toBe("memory-augmented");
  });

  test("non-memory topology (fixture diamond) has no curator waves (backward compat)", () => {
    const d = parsed(join(FIXTURES, "minimal-diamond.yaml"));
    expect(d.memory).toBeUndefined();
    expect(d.waves.some((w: { curator?: boolean }) => w.curator === true)).toBe(false);
  });
});
