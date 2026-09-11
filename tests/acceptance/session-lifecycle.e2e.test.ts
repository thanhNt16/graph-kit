// tests/acceptance/session-lifecycle.e2e.test.ts
// Drives the real CLI (bun run src/index.ts, same pattern as
// advisor-fanout.e2e.test.ts) through one full session lifecycle:
// template pack → template list → template materialize --use →
// graph list → graph switch → graph show → graph waves → compile.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TEMPLATE_NAME = "session-lifecycle";

async function runCli(args: string[], cwd: string) {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// Zero parameters, two-node diamond — `template materialize` needs no
// --params, so the lifecycle exercises the default path end to end.
const GRAPH_YAML = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: session-lifecycle
  description: Packed, materialized, switched, shown, waved, compiled.
topology: diamond
nodes:
  reviewer:
    agent: code-reviewer
    objective: Audit the codebase and record findings.
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

describe("session lifecycle e2e over real CLI (pack → materialize --use → list/switch/show → waves → compile)", () => {
  let tmpCwd: string;
  let sessionId: string;
  let sessionPath: string;

  beforeAll(() => {
    tmpCwd = join(tmpdir(), `gk-session-lifecycle-e2e-${process.pid}-${Date.now()}`);
    mkdirSync(tmpCwd, { recursive: true });

    // Seed agent directory with real repo agents so validateGraph passes the
    // agent-binding check (materialize, waves, and compile all validate).
    const agentDir = join(tmpCwd, ".omp", "agents");
    mkdirSync(agentDir, { recursive: true });
    for (const name of ["software-architect.md", "code-reviewer.md"]) {
      const src = join(REPO_ROOT, ".omp", "agents", name);
      if (!existsSync(src))
        throw new Error(`e2e fixture missing: ${src} — the agent-binding check needs real repo agents`);
      writeFileSync(join(agentDir, name), readFileSync(src, "utf-8"));
    }
    writeFileSync(join(tmpCwd, "graph.yaml"), GRAPH_YAML);
  });

  afterAll(() => {
    if (existsSync(tmpCwd)) {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("1. `gk template pack` packs graph.yaml into the project store", async () => {
    const res = await runCli(["template", "pack", join(tmpCwd, "graph.yaml"), "--name", TEMPLATE_NAME], tmpCwd);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.name).toBe(TEMPLATE_NAME);
    expect(parsed.data.origin).toBe("project");
    expect(parsed.data.parameterCount).toBe(0);
    expect(existsSync(join(tmpCwd, ".graphkit", "templates", `${TEMPLATE_NAME}.gk.yaml`))).toBe(true);
  });

  test("2. `gk template list` reports the packed template", async () => {
    const res = await runCli(["template", "list", "--json"], tmpCwd);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe("ok");
    const found = parsed.data.templates.find((t: { name: string }) => t.name === TEMPLATE_NAME);
    expect(found).toBeDefined();
    expect(found.origin).toBe("project");
  });

  test("3. `gk template materialize --use` saves a session graph and flips the active pointer", async () => {
    const res = await runCli(["template", "materialize", TEMPLATE_NAME, "--use"], tmpCwd);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe("ok");
    sessionId = parsed.data.id;
    sessionPath = parsed.data.path;
    expect(typeof sessionId).toBe("string");
    expect(sessionId).toContain(TEMPLATE_NAME);
    expect(existsSync(sessionPath)).toBe(true);
    expect(parsed.data.active).toBe(sessionId);
  });

  test("4. `gk graph list` shows the materialized session as active", async () => {
    const res = await runCli(["graph", "list", "--json"], tmpCwd);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe("ok");
    const ids = parsed.data.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(sessionId);
    expect(parsed.data.active).toBe(sessionId);
  });

  test("5. `gk graph switch <id>` re-points the active session", async () => {
    const res = await runCli(["graph", "switch", sessionId, "--json"], tmpCwd);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.active).toBe(sessionId);
  });

  test("6. `gk graph show <id>` prints the session graph's YAML", async () => {
    const res = await runCli(["graph", "show", sessionId], tmpCwd);
    expect(res.exitCode).toBe(0);
    const doc = YAML.parse(res.stdout);
    expect(doc.metadata.name).toBe(TEMPLATE_NAME);
    expect(Object.keys(doc.nodes).sort()).toEqual(["reviewer", "synthesizer"]);
  });

  test("7. `gk graph waves <file>` emits a wave plan with total_waves > 0", async () => {
    const res = await runCli(["graph", "waves", sessionPath, "--json"], tmpCwd);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.total_waves).toBeGreaterThan(0);
    expect(Array.isArray(parsed.data.waves)).toBe(true);
    const ids = parsed.data.waves.flatMap((w: { nodes: Array<{ id: string }> }) => w.nodes.map((n) => n.id));
    expect(ids).toEqual(["reviewer", "synthesizer"]); // diamond order: reviewer before synthesizer
  });

  test("8. `gk compile` writes the .workflow.js artifact", async () => {
    const res = await runCli(["compile", "--json"], tmpCwd);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.compiled).toMatch(/\.workflow\.js$/);
    expect(parsed.data.topology).toBe("diamond");
    expect(existsSync(parsed.data.compiled)).toBe(true);
  });
});
