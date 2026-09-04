// tests/acceptance/advisor-fanout.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");

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

const GRAPH_YAML = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: orch-smoke
topology: custom
nodes:
  plan:
    agent: software-architect
    model: fable
    objective: Write .graphkit/evidence/plan/briefs.json as a JSON array of briefs.
  exec:
    agent: code-reviewer
    model: sonnet
    objective: Execute all briefs from the plan.
    depend_on: [plan]
    loop: { enabled: true, max_rounds: 4, stop_when: "all briefs executed" }
    advisor: { model: fable, after_failed_rounds: 2, max_calls: 1 }
    fan_out: { briefs_from: plan, template: "Implement {brief.title}: {brief.body}" }
`;

describe("advisor + fan-out e2e smoke over real CLI", () => {
  let tmpCwd: string;

  beforeAll(() => {
    tmpCwd = join(tmpdir(), `gk-advisor-fanout-e2e-${process.pid}-${Date.now()}`);
    mkdirSync(tmpCwd, { recursive: true });

    // Seed agent directory with real repo agents so validateGraph passes agent-binding check
    const agentDir = join(tmpCwd, ".omp", "agents");
    mkdirSync(agentDir, { recursive: true });
    for (const name of ["software-architect.md", "code-reviewer.md"]) {
      const src = join(REPO_ROOT, ".omp", "agents", name);
      if (existsSync(src)) {
        writeFileSync(join(agentDir, name), readFileSync(src, "utf-8"));
      } else {
        writeFileSync(join(agentDir, name), `# ${name}\nAgent description`);
      }
    }

    writeFileSync(join(tmpCwd, "graph.yaml"), GRAPH_YAML);
  });

  afterAll(() => {
    if (existsSync(tmpCwd)) {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("1. `gk validate` validates graph with advisor + fan_out without findings", async () => {
    const res = await runCli(["validate"], tmpCwd);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.valid).toBe(true);
    expect(parsed.data.topology).toBe("custom");
  });

  test("2. `gk graph waves` emits waves payload with advisor and fan_out node metadata", async () => {
    const res = await runCli(["graph", "waves"], tmpCwd);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.graph).toBe("orch-smoke");

    const allNodes = parsed.data.waves.flatMap((w: { nodes: Array<{ id: string; advisor: unknown; fan_out: unknown }> }) => w.nodes);
    const execNode = allNodes.find((n: { id: string }) => n.id === "exec");
    expect(execNode).toBeDefined();
    expect(execNode.advisor).toEqual({
      model: "fable",
      after_failed_rounds: 2,
      max_calls: 1,
    });
    expect(execNode.fan_out).toEqual({
      briefs_from: "plan",
      template: "Implement {brief.title}: {brief.body}",
    });
  });

  test("3-7. `gk run start` → `gk run node` fail → `gk run node --advisor-fired` → `gk run status` → `gk run end`", async () => {
    // 3. start run
    const startRes = await runCli(["run", "start"], tmpCwd);
    expect(startRes.exitCode).toBe(0);
    const startData = JSON.parse(startRes.stdout);
    expect(startData.status).toBe("ok");
    const runId = startData.data.id;
    const runDir = startData.data.dir;
    expect(runId).toContain("orch-smoke");

    // 4. record failed node
    const nodeRes = await runCli(["run", "node", "exec", "--status", "fail", "--wave", "1"], tmpCwd);
    expect(nodeRes.exitCode).toBe(0);
    const nodeData = JSON.parse(nodeRes.stdout);
    expect(nodeData.status).toBe("ok");
    expect(nodeData.data.node).toBe("exec");

    // 5. record advisor firing with round 2 and streak 2
    const advRes = await runCli(["run", "node", "exec", "--advisor-fired", "2", "--streak", "2"], tmpCwd);
    expect(advRes.exitCode).toBe(0);
    const advData = JSON.parse(advRes.stdout);
    expect(advData.status).toBe("ok");
    expect(advData.data.event.tier).toBe("fable");
    expect(advData.data.event.round).toBe(2);
    expect(advData.data.event.streak).toBe(2);

    const advisorJsonlPath = join(runDir, "advisor.jsonl");
    expect(existsSync(advisorJsonlPath)).toBe(true);
    const lines = readFileSync(advisorJsonlPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const ev = JSON.parse(lines[0]);
    expect(ev.node).toBe("exec");
    expect(ev.tier).toBe("fable");
    expect(ev.round).toBe(2);
    expect(ev.streak).toBe(2);

    // 6. run status reports active run and advisor_events count === 1
    const statusRes = await runCli(["run", "status"], tmpCwd);
    expect(statusRes.exitCode).toBe(0);
    const statusData = JSON.parse(statusRes.stdout);
    expect(statusData.status).toBe("ok");
    expect(statusData.data.active).toBe(runDir);
    expect(statusData.data.advisor_events).toBe(1);

    // 7. end run with status failed
    const endRes = await runCli(["run", "end", "--status", "failed"], tmpCwd);
    expect(endRes.exitCode).toBe(0);
    const endData = JSON.parse(endRes.stdout);
    expect(endData.status).toBe("ok");
    expect(endData.data.status).toBe("failed");
    expect(endData.data.failures).toBe(1);
  });

  test("8. second scripted run with advisor event + `gk memory consolidate` emits pattern and suggestion", async () => {
    // Run 2: start -> advisor-fired -> end
    const start2 = await runCli(["run", "start"], tmpCwd);
    expect(start2.exitCode).toBe(0);

    const adv2 = await runCli(["run", "node", "exec", "--advisor-fired", "1", "--streak", "1"], tmpCwd);
    expect(adv2.exitCode).toBe(0);

    const end2 = await runCli(["run", "end", "--status", "failed"], tmpCwd);
    expect(end2.exitCode).toBe(0);

    // Consolidate memory
    const consRes = await runCli(["memory", "consolidate"], tmpCwd);
    expect(consRes.exitCode).toBe(0);
    const consData = JSON.parse(consRes.stdout);
    expect(consData.status).toBe("ok");
    expect(consData.data.runs).toBe(2);
    expect(consData.data.patterns).toBeGreaterThanOrEqual(1);
    expect(consData.data.suggestions).toBeGreaterThanOrEqual(1);

    const memDir = join(tmpCwd, ".graphkit", "memory");
    const patternFiles = readdirSync(join(memDir, "patterns")).filter((f) => f.endsWith(".md"));
    expect(patternFiles.length).toBeGreaterThanOrEqual(1);

    const advisorPatterns = patternFiles.filter((f) => {
      const raw = readFileSync(join(memDir, "patterns", f), "utf-8");
      const match = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return false;
      const parsed = YAML.parse(match[1]);
      return parsed.kind === "advisor-repeat" && Array.isArray(parsed.members) && parsed.members.includes("exec");
    });
    expect(advisorPatterns.length).toBe(1);

    const suggestionFiles = readdirSync(join(memDir, "suggestions")).filter((f) => f.endsWith(".md"));
    expect(suggestionFiles.length).toBeGreaterThanOrEqual(1);
    const suggestionBodies = suggestionFiles.map((f) => readFileSync(join(memDir, "suggestions", f), "utf-8"));
    const match = suggestionBodies.some((body) =>
      body.includes("raise exec model tier or loosen its stop_when"),
    );
    expect(match).toBe(true);
  });
});
