import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import type { TraceLine } from "../../src/runs/ledger.js";
import { buildRunReport, renderRunHtml, writeRunReport } from "../../src/runs/report.js";

let cwd: string;
beforeEach(() => {
  cwd = join(tmpdir(), `gk-run-report-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function seedRun(id: string, trace: TraceLine[] = []) {
  const dir = join(cwd, ".graphkit", "runs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      id,
      graph: "g",
      graph_path: "/nonexistent/graph.yaml",
      graph_sha256: "x",
      started_at: "2026-01-01T00:00:00.000Z",
    }),
  );
  writeFileSync(join(dir, "trace.jsonl"), `${trace.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

const nodeLine = (node: string, status: TraceLine["status"]): TraceLine => ({
  at: "2026-01-01T00:00:01.000Z",
  node,
  wave: 0,
  agent: "a",
  model: "fable",
  status,
  evidence: ["brief"],
  duration_ms: 100,
  notes: null,
});

function runCli(args: string[]) {
  const cli = cac("gk");
  registerRunCommands(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  process.chdir(cwd);
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
  }
  const code = process.exitCode ? Number(process.exitCode) : 0;
  process.exitCode = 0;
  return { stdout: logs.join("\n"), code };
}

describe("gk run report", () => {
  test("writes a self-contained HTML report for a closed run", () => {
    seedRun("20260101-000001-a", [nodeLine("plan", "ok"), nodeLine("build", "fail")]);
    const out = writeRunReport(cwd, "20260101-000001-a");
    expect(out).toBe(join(cwd, ".graphkit", "reports", "20260101-000001-a-run.html"));
    expect(existsSync(out)).toBe(true);
    const html = renderRunHtml(buildRunReport(cwd, "20260101-000001-a"));
    expect(html).toContain("Run report");
    expect(html).toContain("20260101-000001-a");
    expect(html).toContain("plan");
    expect(html).toContain("build");
    // Self-contained: no external requests.
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<script");
  });

  test("escapes HTML in trace notes (XSS-safe)", () => {
    seedRun("20260101-000002-a", [{ ...nodeLine("evil<script>", "ok"), notes: "<img src=x>" }]);
    const html = renderRunHtml(buildRunReport(cwd, "20260101-000002-a"));
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img");
  });

  test("gk run report emits the path; missing id fails cleanly", () => {
    seedRun("20260101-000003-a", [nodeLine("plan", "ok")]);
    const r = runCli(["run", "report", "20260101-000003-a"]);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("ok");
    expect(env.data.report).toContain(".graphkit/reports/20260101-000003-a-run.html");
    const bad = runCli(["run", "report"]);
    expect(bad.stdout).toContain("MISSING_ARG");
  });
});
