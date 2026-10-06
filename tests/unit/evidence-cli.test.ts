import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerEvidenceCommand } from "../../src/cli/commands/evidence.js";
import { parseMarker } from "../../src/evidence/marker.js";

let cwd: string;
const graphYaml = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
nodes:
  probe:
    agent: a
    objective: o
    depend_on: []
    evidence: [api-response]
evidence:
  required_keys: [api-response]
`;

function runCli(args: string[]) {
  const origCwd = process.cwd();
  process.chdir(cwd);
  const cli = cac("gk");
  registerEvidenceCommand(cli);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let code = 0;
  const origExit = process.exit;
  process.exit = ((c?: number) => {
    code = c ?? 1;
  }) as typeof process.exit;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    code = code || ((process.exitCode as number | undefined) ?? 0);
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
    console.log = origLog;
    process.exit = origExit;
    process.chdir(origCwd);
  }
  return { stdout: logs.join("\n"), code };
}

beforeEach(() => {
  cwd = join(tmpdir(), `gk-evcli-${process.pid}-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(cwd, ".omp", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".omp", "agents", "a.md"), "# A\n");
  writeFileSync(join(cwd, "graph.yaml"), graphYaml);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("gk evidence add", () => {
  test("adds artifact via CLI", () => {
    writeFileSync(join(cwd, "r.json"), "{}");
    const r = runCli(["evidence", "add", "r.json", "--key", "api-response", "--node", "probe", "--json"]);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("ok");
    expect(env.data.key).toBe("api-response");
    expect(env.data.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("undeclared key exits 1 with code", () => {
    writeFileSync(join(cwd, "r.json"), "{}");
    const r = runCli(["evidence", "add", "r.json", "--key", "bogus", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("EVIDENCE_KEY_NOT_DECLARED");
  });

  test("missing --key fails fast", () => {
    const r = runCli(["evidence", "add", "r.json", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("MISSING_ARG");
  });

  test("unknown leaf rejected", () => {
    const r = runCli(["evidence", "bogus", "--json"]);
    expect(JSON.parse(r.stdout).error.code).toBe("UNKNOWN_EVIDENCE_SUBCOMMAND");
  });
});

describe("gk evidence invalidate", () => {
  test("writes superseded marker", () => {
    writeFileSync(join(cwd, "r.json"), "{}");
    runCli(["evidence", "add", "r.json", "--key", "api-response", "--json"]);
    const r = runCli(["evidence", "invalidate", "--key", "api-response", "--note", "premise disproved", "--json"]);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("ok");
    expect(env.data.superseded).toBe(true);
    const md = readFileSync(join(cwd, ".graphkit", "evidence", "api-response.md"), "utf-8");
    expect(parseMarker(md)?.superseded).toBe("premise disproved");
  });

  test("missing --key fails", () => {
    const r = runCli(["evidence", "invalidate", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("MISSING_ARG");
  });

  test("unknown key fails EVIDENCE_KEY_MISSING", () => {
    const r = runCli(["evidence", "invalidate", "--key", "nope", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("EVIDENCE_KEY_MISSING");
  });

  test("invalidated key reports superseded, not present (gate parity)", () => {
    writeFileSync(join(cwd, "r.json"), "{}");
    runCli(["evidence", "add", "r.json", "--key", "api-response", "--json"]);
    runCli(["evidence", "invalidate", "--key", "api-response", "--note", "premise disproved", "--json"]);
    const r = runCli(["evidence", "report", "--json"]);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("ok");
    expect(env.data.views[0].status).toBe("superseded");
    expect(env.data.markdown).toContain("◌ superseded");
    expect(env.data.markdown).not.toContain("● present");
  });
});

describe("gk evidence --graph", () => {
  const subGraphYaml = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: sub
topology: diamond
nodes:
  probe:
    agent: a
    objective: o
    depend_on: []
    evidence: [sub-only-key]
evidence:
  required_keys: [sub-only-key]
`;

  // Minimal active-run fixture: .active names a run dir whose meta.json
  // records graph_path — exactly what ledger.startRun writes.
  function startFakeRun(graphPath: string) {
    const runDir = join(cwd, ".graphkit", "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "runs", ".active"), `${runDir}\n`);
    writeFileSync(join(runDir, "meta.json"), JSON.stringify({ graph_path: graphPath }));
  }

  test("add with --graph validates keys against THAT graph, not <cwd>/graph.yaml", () => {
    mkdirSync(join(cwd, "sub"), { recursive: true });
    writeFileSync(join(cwd, "sub", "x.yaml"), subGraphYaml);
    writeFileSync(join(cwd, "r.json"), "{}");
    const r = runCli(["evidence", "add", "r.json", "--key", "sub-only-key", "--graph", "sub/x.yaml", "--json"]);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("ok");
    expect(env.data.key).toBe("sub-only-key");
  });

  test("fallback order: --graph beats active-run graph beats <cwd>/graph.yaml", () => {
    mkdirSync(join(cwd, "sub"), { recursive: true });
    writeFileSync(join(cwd, "sub", "x.yaml"), subGraphYaml);
    writeFileSync(join(cwd, "r.json"), "{}");
    // no run, no --graph → cwd graph.yaml (declares api-response only)
    const bare = runCli(["evidence", "add", "r.json", "--key", "sub-only-key", "--json"]);
    expect(JSON.parse(bare.stdout).error.code).toBe("EVIDENCE_KEY_NOT_DECLARED");
    // active run records sub/x.yaml → key resolves with no --graph
    startFakeRun("sub/x.yaml");
    const viaRun = runCli(["evidence", "add", "r.json", "--key", "sub-only-key", "--json"]);
    expect(JSON.parse(viaRun.stdout).status).toBe("ok");
    // explicit --graph overrides the active-run graph
    const explicit = runCli(["evidence", "add", "r.json", "--key", "sub-only-key", "--graph", "graph.yaml", "--json"]);
    expect(JSON.parse(explicit.stdout).error.code).toBe("EVIDENCE_KEY_NOT_DECLARED");
  });

  test("--graph that is neither a file nor a session id -> GRAPH_NOT_FOUND", () => {
    writeFileSync(join(cwd, "r.json"), "{}");
    const r = runCli(["evidence", "add", "r.json", "--key", "api-response", "--graph", "nope.yaml", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("GRAPH_NOT_FOUND");
  });

  test("report --graph reads keys and evidence_dir from that graph", () => {
    mkdirSync(join(cwd, "sub"), { recursive: true });
    writeFileSync(join(cwd, "sub", "x.yaml"), subGraphYaml);
    const r = runCli(["evidence", "report", "--graph", "sub/x.yaml", "--json"]);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("ok");
    expect(env.data.views.map((v: { id: string }) => v.id)).toEqual(["sub-only-key"]);
  });
});
