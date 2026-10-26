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
      "read,glob,grep",
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
    expect(buildPiArgs(args({ no_write: true }))).toEqual(["-p", "--tools", "read,glob,grep,bash"]);
  });
});

describe("buildPiArgs omp flags", () => {
  const base: DispatchArgs = { agent: "x", objective: "x" };

  test("skills list joins into --skills; [] emits --no-skills; unset emits neither", () => {
    expect(buildPiArgs({ ...base, skills: ["factory-build", "gk-recall"] })).toEqual([
      "-p",
      "--skills",
      "factory-build,gk-recall",
    ]);
    expect(buildPiArgs({ ...base, skills: [] })).toEqual(["-p", "--no-skills"]);
    expect(buildPiArgs(base)).toEqual(["-p"]);
  });

  test("thinking, max_time, extensions, mode_json, approval_mode, no_session", () => {
    expect(
      buildPiArgs({
        ...base,
        thinking: "medium",
        max_time: "45m",
        extensions: ["/a/guard.ts", "/b/log.ts"],
        mode_json: true,
        approval_mode: "yolo",
        no_session: true,
      }),
    ).toEqual([
      "-p",
      "--thinking",
      "medium",
      "--max-time",
      "45m",
      "-e",
      "/a/guard.ts",
      "-e",
      "/b/log.ts",
      "--mode",
      "json",
      "--approval-mode",
      "yolo",
      "--no-session",
    ]);
  });

  test("flags compose with constraints", () => {
    expect(buildPiArgs({ ...base, constraints: { no_exec: true }, skills: ["s1"], model: "m1" })).toEqual([
      "-p",
      "--model",
      "m1",
      "--tools",
      "read,glob,grep",
      "--skills",
      "s1",
    ]);
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

  test("env: replaces process.env — child never sees scrubbed vars", async () => {
    const { out, err } = await runScript(`
      ${setup}
      writeFileSync(omp, '#!/bin/sh\\ncat >/dev/null\\nexec node -e "console.log((process.env.GH_TOKEN||\\'none\\') + \\'|\\' + (process.env.MYVAR||\\'none\\'))"');
      chmodSync(omp, 0o755);
      process.env.GH_TOKEN = "secret-token";
      process.env.MYVAR = "mine";
      const { spawnDispatch } = await import(process.env.GK_ROOT + "/src/exec/spawn.ts");
      const r = await spawnDispatch({
        agent: "worker", objective: "env check", cwd: tmp,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      if (!r.ok) throw new Error("not ok: " + JSON.stringify(r));
      if (r.output !== "none|none") throw new Error("env leak: " + JSON.stringify(r.output));
      console.log("OK");
    `);
    expect(err).toBe("");
    expect(out).toBe("OK");
  });

  test("GK_OMP_BIN: custom binary receives flags and stdin prompt", async () => {
    const { out, err } = await runScript(`
      ${setup}
      const fake = join(stubDir, "fake-omp");
      writeFileSync(fake, '#!/bin/sh\\ncat >/dev/null\\nexec node -e "console.log(process.argv.slice(1).join(\\',\\'))" -- "$@"');
      chmodSync(fake, 0o755);
      process.env.GK_OMP_BIN = fake;
      const { spawnDispatch } = await import(process.env.GK_ROOT + "/src/exec/spawn.ts");
      const r = await spawnDispatch({
        agent: "worker", objective: "x", cwd: tmp,
        skills: ["a","b"], thinking: "high", max_time: "10m",
        extensions: ["/ext/g.ts"], mode_json: false, no_session: true,
        approval_mode: "yolo",
      });
      if (!r.ok) throw new Error("not ok: " + JSON.stringify(r));
      const want = "-p,--skills,a\\,b,--thinking,high,--max-time,10m,-e,/ext/g.ts,--approval-mode,yolo,--no-session";
      if (r.output !== want) throw new Error("argv: " + JSON.stringify(r.output));
      console.log("OK");
    `);
    expect(err).toBe("");
    expect(out).toBe("OK");
  });

  test("mode_json: event stream persisted, text extracted, blocked surfaced", async () => {
    const { out, err } = await runScript(`
      ${setup}
      const streamPath = join(tmp, "stream.jsonl");
      writeFileSync(streamPath, [
        '{"type":"session","id":"s1"}',
        '{"type":"agent_start"}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done ok"}],"stopReason":"stop"}}',
        '{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","isError":true,"result":{"details":{"error":"gk-factory: denied"}}}',
        '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done ok"}],"stopReason":"stop"}],"isTerminal":true}',
      ].join("\\n") + "\\n");
      writeFileSync(omp, '#!/bin/sh\\ncat >/dev/null\\nexec cat "' + streamPath + '"');
      chmodSync(omp, 0o755);
      const { spawnDispatch } = await import(process.env.GK_ROOT + "/src/exec/spawn.ts");
      const r = await spawnDispatch({ agent: "worker", objective: "x", node: "n9", attempt: 2, cwd: tmp, mode_json: true });
      if (!r.ok) throw new Error("not ok: " + JSON.stringify(r));
      if (r.output !== "done ok") throw new Error("output: " + JSON.stringify(r.output));
      if (!r.eventsPath || !r.eventsPath.includes("omp-events/n9-a2.jsonl")) throw new Error("eventsPath: " + JSON.stringify(r));
      const { existsSync } = require("node:fs");
      if (!existsSync(r.eventsPath)) throw new Error("events file missing: " + r.eventsPath);
      if (!r.blocked || r.blocked[0].tool !== "bash" || !r.blocked[0].reason.includes("denied"))
        throw new Error("blocked: " + JSON.stringify(r.blocked));
      console.log("OK");
    `);
    expect(err).toBe("");
    expect(out).toBe("OK");
  });
});
