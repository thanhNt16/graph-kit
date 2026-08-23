import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { registerMemoryCommands } from "../../src/cli/commands/memory.js";

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
const EVERY3 = join(tmpdir(), `gk-waves-mem-every3-${process.pid}-${Date.now()}.yaml`);

writeFileSync(
  ON_NODE,
  `topology: memory-augmented
topology_config:
  memory:
    curator_node: curator
    cadence: on_node_complete
    recall_topk: 7
    expire_policy: manual
    null_intervention_allowed: false
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
  EVERY3,
  `topology: memory-augmented
topology_config:
  memory: { curator_node: curator, cadence: every, every: 3 }
nodes:
  scouter: { agent: Software Architect, depend_on: [] }
  worker: { agent: Code Reviewer, depend_on: [scouter] }
  w1: { agent: Code Reviewer, depend_on: [worker] }
  w2: { agent: Code Reviewer, depend_on: [worker] }
  synthesizer: { agent: Software Architect, depend_on: [w1, w2] }
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
    expect(d.memory).toEqual({
      curator_node: "curator",
      cadence: "on_node_complete",
      every: 1,
      recall_topk: 7,
      expire_policy: "manual",
      null_intervention_allowed: false,
    });
    expect(d.topology).toBe("memory-augmented");
  });

  test("cadence counts completed action nodes: every:3 fires after the wave crossing node 3, never mid-wave", () => {
    // 5 action nodes in waves [scouter], [worker], [w1,w2], [synthesizer].
    // Cumulative action-node count crosses 3 only at the end of wave 3 ([w1,w2]).
    const d = parsed(EVERY3);
    const idxs = d.waves
      .map((w: { curator?: boolean }, i: number) => (w.curator ? i : -1))
      .filter((i: number) => i >= 0);
    expect(idxs).toEqual([3]); // one fire, positioned after the third action wave; final already curated
  });

  test("no duplicate final curator when cadence already fired on the last wave", () => {
    const d = parsed(EVERY3);
    const curatorWaves = d.waves.filter((w: { curator?: boolean }) => w.curator === true);
    expect(curatorWaves.length).toBe(1); // fired at wave crossing + no extra end-of-run duplicate
  });

  test("non-memory topology (fixture diamond) has no curator waves (backward compat)", () => {
    const d = parsed(join(FIXTURES, "minimal-diamond.yaml"));
    expect(d.memory).toBeUndefined();
    expect(d.waves.some((w: { curator?: boolean }) => w.curator === true)).toBe(false);
  });
});

describe("memory config allowlist + bare gk memory (exec-tests step 5)", () => {
  test("graph inspect memory-augmented lists memory.every and memory.null_intervention_allowed keys", () => {
    const cli = cac("gk");
    registerGraphCommands(cli);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      cli.parse(["node", "gk", "graph", "inspect", "memory-augmented"], { run: true });
    } finally {
      console.log = origLog;
    }
    const data = JSON.parse(logs.join("\n")).data;
    expect(data.config_keys).toContain("memory.every");
    expect(data.config_keys).toContain("memory.null_intervention_allowed");
    expect(data.config_keys).toContain("memory.recall_topk");
    expect(data.config_keys).toContain("memory.expire_policy");
  });

  test("bare `gk memory` prints help and exits 0 (not a raw CACError)", async () => {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "..", "src", "index.ts"), "memory"], {
      cwd: tmpdir(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("usage"); // help text, not an error dump
    expect(out).not.toContain("CACError");
  });

  test("gk memory recall surfaces MEMORY_DIR_UNREADABLE when the store exists but is unreadable", async () => {
    if (process.getuid?.() === 0) return; // chmod is a no-op for root — skip
    const cwd = join(tmpdir(), `gk-mem-unreadable-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "memory"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "memory", "m.md"), "---\nid: m\ntype: knowledge\n---\nbody\n");
    chmodSync(join(cwd, ".graphkit", "memory"), 0o000);
    try {
      const cli = cac("gk");
      registerMemoryCommands(cli);
      const logs: string[] = [];
      let exitCode = 0;
      const origLog = console.log;
      console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
      const origExit = process.exit;
      process.exit = (c?: number) => {
        exitCode = c ?? 1;
      };
      const previousCwd = process.cwd();
      try {
        process.chdir(cwd);
        cli.parse(["node", "gk", "memory", "recall", "--json", "anything"], { run: true });
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        process.chdir(previousCwd);
        console.log = origLog;
        process.exit = origExit;
      }
      const out = JSON.parse(logs.join("\n"));
      expect(out.status).toBe("fail");
      expect(out.error.code).toBe("MEMORY_DIR_UNREADABLE");
      expect(exitCode).toBe(1);
      process.exitCode = 0;
    } finally {
      chmodSync(join(cwd, ".graphkit", "memory"), 0o755);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
