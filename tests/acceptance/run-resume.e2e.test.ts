// tests/acceptance/run-resume.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");

async function runCli(args: string[], cwd: string) {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

const GRAPH = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: resume-e2e
topology: custom
nodes:
  scan:
    agent: scout
    objective: Scan.
    evidence: [scan-done]
  build:
    agent: implementer
    objective: Build.
    depend_on: [scan]
    evidence: [build-done]
`;

describe("run resume e2e", () => {
  let cwd: string;
  beforeAll(() => {
    cwd = join(tmpdir(), `gk-resume-e2e-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "graphs"), { recursive: true });
    const agents = join(cwd, ".omp", "agents");
    mkdirSync(agents, { recursive: true });
    for (const a of ["scout.md", "implementer.md"]) writeFileSync(join(agents, a), "---\ndescription: test\n---\n");
    writeFileSync(join(cwd, "graph.yaml"), GRAPH);
  });
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  test("full cycle: fail → resume → derived graph → provenance chain", async () => {
    // 1. start + scan passes with evidence, build fails → end failed
    const start = JSON.parse((await runCli(["run", "start", "--json"], cwd)).stdout);
    writeFileSync(join(cwd, ".graphkit", "evidence", "scan-done.md"), "scan output\n");
    await runCli(
      ["run", "node", "scan", "--status", "ok", "--evidence", "scan-done", "--wave", "0", "--agent", "scout", "--json"],
      cwd,
    );
    await runCli(["run", "node", "build", "--status", "fail", "--wave", "1", "--agent", "implementer", "--json"], cwd);
    await runCli(["run", "end", "--status", "failed", "--json"], cwd);

    // 2. resume
    const resume = JSON.parse((await runCli(["run", "resume", start.data.id, "--json"], cwd)).stdout);
    expect(resume.data.resumed).toBe(true);
    expect(resume.data.pending).toEqual(["build"]);

    // 3. derived graph content
    const derived = YAML.parse(readFileSync(resume.data.session.path, "utf-8"));
    expect(Object.keys(derived.nodes)).toEqual(["build"]);
    expect(derived.nodes.build.refs).toEqual([
      { path: ".graphkit/evidence/scan-done.md", purpose: `resumed evidence from node scan (run ${start.data.id})` },
    ]);

    // 4. child run is active with provenance; status shows the chain
    const status = JSON.parse((await runCli(["run", "status", "--json"], cwd)).stdout);
    expect(status.data.resumes_chain).toEqual([resume.data.run.id, start.data.id]);

    // 5. child passes → end merged
    writeFileSync(join(cwd, ".graphkit", "evidence", "build-done.md"), "build output\n");
    await runCli(
      [
        "run",
        "node",
        "build",
        "--status",
        "ok",
        "--evidence",
        "build-done",
        "--wave",
        "0",
        "--agent",
        "implementer",
        "--json",
      ],
      cwd,
    );
    const end = JSON.parse((await runCli(["run", "end", "--status", "merged", "--json"], cwd)).stdout);
    expect(end.data.status).toBe("merged");
    expect(end.data.evidence_keys).toEqual(["build-done"]);
  });
});
