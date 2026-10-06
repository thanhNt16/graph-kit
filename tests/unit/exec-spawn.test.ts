import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildPiArgs, buildPrompt, type DispatchArgs, spawnDispatch } from "../../src/exec/spawn";

const ROOT = join(import.meta.dir, "..", "..");

describe("buildPiArgs constraint precedence", () => {
  const args = (constraints?: DispatchArgs["constraints"], model?: string): DispatchArgs => ({
    agent: "x",
    objective: "x",
    constraints,
    model,
  });

  test("headless flag always present, no constraints → bare -p", () => {
    expect(buildPiArgs(args())).toEqual(["-p"]);
  });

  test("model rides after -p", () => {
    expect(buildPiArgs(args(undefined, "slow"))).toEqual(["-p", "--model", "slow"]);
  });

  test("no_exec removes the shell entirely and beats every other constraint", () => {
    expect(buildPiArgs(args({ no_exec: true, tools_allowlist: ["Write"] }))).toEqual([
      "-p",
      "--tools",
      "Read,Glob,Grep",
    ]);
  });

  test("explicit allowlist beats the no_write default", () => {
    expect(buildPiArgs(args({ no_write: true, tools_allowlist: ["Read", "Write"] }))).toEqual([
      "-p",
      "--tools",
      "Read,Write",
    ]);
  });

  test("no_write keeps Bash (best-effort)", () => {
    expect(buildPiArgs(args({ no_write: true }))).toEqual(["-p", "--tools", "Read,Glob,Grep,Bash"]);
  });
});

describe("buildPrompt", () => {
  test("objective plus context, blank-line separated", () => {
    expect(buildPrompt({ agent: "x", objective: "do it", context: "upstream said hi" })).toBe(
      "## Objective\ndo it\n\n## Context\nupstream said hi",
    );
  });

  test("objective only when no context", () => {
    expect(buildPrompt({ agent: "x", objective: "do it" })).toBe("## Objective\ndo it");
  });
});

describe("spawnDispatch fail-fast (in-process)", () => {
  test("unknown agent fails without spawning a child", async () => {
    const r = await spawnDispatch({ agent: "__missing_agent__", objective: "x" });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("__missing_agent__");
  });
});

// Spawn-path tests run in a subprocess: the PATH stub (fake `omp`) is a
// process-global mutation that would race sibling test files, mirroring the
// isolation pattern of pi-kit.test.ts's dispatch-intent test.
describe("spawnDispatch (subprocess-isolated)", () => {
  const runScript = async (script: string) => {
    const proc = Bun.spawnSync(["bun", "-e", script], {
      cwd: ROOT,
      env: { ...process.env, GK_ROOT: ROOT },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { out: proc.stdout.toString().trim(), err: proc.stderr.toString().trim() };
  };

  const setup = `
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "gk-spawn-"));
    mkdirSync(join(tmp, ".omp", "agents"), { recursive: true });
    writeFileSync(join(tmp, ".omp", "agents", "worker.md"), "You are worker.\\n");
    const run = join(tmp, ".graphkit", "runs", "r1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(tmp, ".graphkit", "runs", ".active"), run);
    const stubDir = join(tmp, "bin");
    mkdirSync(stubDir);
    const omp = join(stubDir, "omp");
    process.env.PATH = stubDir + ":" + process.env.PATH;
  `;

  const readIntents = `
    const lines = readFileSync(join(run, "dispatch.jsonl"), "utf8")
      .trim()
      .split("\\n")
      .map((l) => JSON.parse(l));
  `;

  test("success: node -e prints ok → ok outcome + pre/post intent lines", async () => {
    const { out, err } = await runScript(`
      ${setup}
      writeFileSync(omp, '#!/bin/sh\\ncat >/dev/null\\nexec node -e "console.log(\\'ok\\')"');
      chmodSync(omp, 0o755);
      const { spawnDispatch } = await import(process.env.GK_ROOT + "/src/exec/spawn.ts");
      const r = await spawnDispatch({ agent: "worker", objective: "print ok", node: "n1", attempt: 1, cwd: tmp });
      if (!r.ok) throw new Error("not ok: " + JSON.stringify(r));
      if (r.output !== "ok") throw new Error("output: " + JSON.stringify(r.output));
      if (r.exitCode !== 0) throw new Error("exitCode: " + r.exitCode);
      if (typeof r.durationMs !== "number" || r.durationMs < 0) throw new Error("durationMs: " + r.durationMs);
      if (r.timedOut) throw new Error("timedOut should be absent");
      ${readIntents}
      if (lines.length !== 2) throw new Error("expected pre+post intent lines, got " + lines.length);
      if (lines[0].pid !== null) throw new Error("pre-spawn pid not null: " + JSON.stringify(lines[0]));
      if (typeof lines[1].pid !== "number" || lines[1].pid <= 0) throw new Error("post-spawn pid: " + JSON.stringify(lines[1]));
      for (const l of lines) {
        if (l.via !== "extension") throw new Error("via: " + l.via);
        if (l.node !== "n1" || l.attempt !== 1) throw new Error("node/attempt: " + l.node + "/" + l.attempt);
        if (typeof l.at !== "string" || isNaN(Date.parse(l.at))) throw new Error("at: " + l.at);
      }
      console.log("OK");
    `);
    expect(err).toBe("");
    expect(out).toBe("OK");
  });

  test("timeout_ms: sleep 30 killed → timed_out outcome + intent lines", async () => {
    const { out, err } = await runScript(`
      ${setup}
      writeFileSync(omp, '#!/bin/sh\\ncat >/dev/null\\nexec sleep 30');
      chmodSync(omp, 0o755);
      const { spawnDispatch } = await import(process.env.GK_ROOT + "/src/exec/spawn.ts");
      const r = await spawnDispatch({ agent: "worker", objective: "hang", node: "n2", attempt: 1, cwd: tmp, timeout_ms: 100 });
      if (r.ok) throw new Error("should not be ok: " + JSON.stringify(r));
      if (!r.timedOut) throw new Error("timedOut missing: " + JSON.stringify(r));
      if (r.exitCode !== 124) throw new Error("exitCode: " + r.exitCode);
      if (!r.output.includes("TIMEOUT")) throw new Error("no TIMEOUT marker: " + JSON.stringify(r.output));
      ${readIntents}
      if (lines.length !== 2) throw new Error("expected pre+post intent lines, got " + lines.length);
      console.log("OK");
    `);
    expect(err).toBe("");
    expect(out).toBe("OK");
  });

  test("no active run: bookkeeping silent, dispatch still succeeds", async () => {
    const { out, err } = await runScript(`
      ${setup}
      writeFileSync(omp, '#!/bin/sh\\ncat >/dev/null\\nexec node -e "console.log(\\'fine\\')"');
      chmodSync(omp, 0o755);
      const { rmSync } = require("node:fs");
      rmSync(join(tmp, ".graphkit"), { recursive: true, force: true });
      const { spawnDispatch } = await import(process.env.GK_ROOT + "/src/exec/spawn.ts");
      const r = await spawnDispatch({ agent: "worker", objective: "x", cwd: tmp });
      if (!r.ok) throw new Error("dispatch without active run failed: " + r.output);
      console.log("OK");
    `);
    expect(err).toBe("");
    expect(out).toBe("OK");
  });
});
