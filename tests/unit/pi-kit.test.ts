import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../../kits/pi/extensions/gk-subagent";

const ROOT = join(import.meta.dir, "..", "..");
const KIT = join(ROOT, "kits", "pi");

describe("pi kit structure", () => {
  test("all agent fragments carry discovery frontmatter and a role header", () => {
    const dir = join(KIT, "agents");
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = readFileSync(join(dir, f), "utf8");
      const name = f.replace(/\.md$/, "");
      // omp task discovery requires name + description frontmatter.
      expect(raw, `${f} frontmatter`).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---`));
      expect(raw, `${f} role header`).toContain(`You are ${name}, acting as an isolated subagent.`);
    }
  });

  test("fragments carry the claude agent bodies", () => {
    const raw = (f: string) => readFileSync(join(KIT, "agents", f), "utf8");
    expect(raw("data-engineer.md")).toContain("# Data Engineer Agent");
    expect(raw("memory-curator.md")).toContain("# Memory Curator Agent");
  });

  test("11 skills matching cursor set", () => {
    const pi = readdirSync(join(KIT, "skills")).sort();
    const cursor = readdirSync(join(ROOT, "kits", "cursor", "skills")).sort();
    expect(pi).toEqual(cursor);
  });

  test("skill frontmatter names are dash form and match directories", () => {
    const dir = join(KIT, "skills");
    for (const skill of readdirSync(dir)) {
      const raw = readFileSync(join(dir, skill, "SKILL.md"), "utf8");
      const name = raw.match(/^name:\s*(.*)$/m)?.[1]?.trim() ?? "";
      expect(name, `${skill} name`).not.toContain(":");
      expect(name).toBe(skill);
    }
  });

  test("gk-execute carries native task wave protocol", () => {
    const raw = readFileSync(join(KIT, "skills", "gk-execute", "SKILL.md"), "utf8");
    expect(raw).toContain("## Dispatching a wave (pi)");
    expect(raw).toContain("gk graph agents");
    expect(raw).toContain("gk-<node-id>");
    expect(raw).toContain("gk_dispatch_agent"); // fallback path for timeout_ms
    expect(raw).not.toContain("/gk:");
  });

  test("no stale host path references in skills", () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(md|py)$/.test(e.name)) {
          const raw = readFileSync(p, "utf8");
          if (/\.claude|\.cursor/.test(raw)) offenders.push(p);
        }
      }
    };
    walk(join(KIT, "skills"));
    expect(offenders).toEqual([]);
  });

  test("extension ships at extensions/gk-subagent.ts and exports pure functions", () => {
    const ext = join(KIT, "extensions", "gk-subagent.ts");
    expect(existsSync(ext)).toBe(true);
    const raw = readFileSync(ext, "utf8");
    expect(raw).toContain('"gk_dispatch_agent"');
    expect(raw).toContain("export default async function");
    expect(raw).toContain('await import("typebox")');
    expect(raw).not.toContain('".pi"');
  });

  test("prompt template routes through gk-status", () => {
    const raw = readFileSync(join(KIT, "prompts", "gk.md"), "utf8");
    expect(raw).toContain(".omp/skills/gk-status/SKILL.md");
    expect(raw).toContain("$ARGUMENTS");
  });

  test("rules-section.md carries graph-authority rules with AGENTS.md markers", () => {
    const raw = readFileSync(join(KIT, "rules-section.md"), "utf8");
    expect(raw.startsWith("<!-- graphkit:start -->")).toBe(true);
    expect(raw.trimEnd().endsWith("<!-- graphkit:end -->")).toBe(true);
    expect(raw).toContain("graph-authority");
    expect(raw).toContain("agent-binding");
    expect(raw).toContain("topology-routing");
    expect(raw).not.toContain(".pi/");
  });
});

describe("dispatch guard rails", () => {
  test("unknown agent fails fast without spawning a child", async () => {
    const result = await dispatch({ agent: "__nonexistent_agent__", objective: "x" });
    expect(result.ok).toBe(false);
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain("__nonexistent_agent__");
  });
});

describe("dispatch-intent write", () => {
  // Subprocess-isolated: the stub omp itself asserts the intent line already
  // exists when it starts running — proving the record lands after spawn
  // returns but before dispatch() awaits the result. In-process chdir/env
  // mutations are process-global and race sibling test files.
  test("writes via:\"extension\" line before spawn resolves; no active run never fails dispatch", async () => {
    const script = `
      const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } = require("node:fs");
      const { tmpdir } = require("node:os");
      const { join } = require("node:path");
      const tmp = mkdtempSync(join(tmpdir(), "gk-dispatch-"));
      const run = join(tmp, ".graphkit", "runs", "r1");
      mkdirSync(run, { recursive: true });
      writeFileSync(join(tmp, ".graphkit", "runs", ".active"), run);
      const stubDir = join(tmp, "bin");
      mkdirSync(stubDir);
      const omp = join(stubDir, "omp");
      writeFileSync(omp, '#!/bin/sh\\ncat > /dev/null\\ntest -s "$GK_RUN_DIR/dispatch.jsonl" || { echo "no intent line before child ran" >&2; exit 7; }\\nexit 0\\n');
      chmodSync(omp, 0o755);
      process.env.PATH = stubDir + ":" + process.env.PATH;
      process.env.GK_RUN_DIR = run;
      const { dispatch } = await import(process.env.GK_ROOT + "/kits/_core/extensions/gk-subagent.ts");
      const r = await dispatch({ agent: "debugger", objective: "x", node: "n1", attempt: 2, cwd: tmp });
      if (r.exit_code !== 0) throw new Error("dispatch failed: " + r.output);
      const line = JSON.parse(readFileSync(join(run, "dispatch.jsonl"), "utf8").trim().split("\\n").pop());
      if (line.via !== "extension") throw new Error("via: " + line.via);
      if (line.node !== "n1" || line.attempt !== 2) throw new Error("node/attempt: " + line.node + "/" + line.attempt);
      if (typeof line.pid !== "number" || line.pid <= 0) throw new Error("pid: " + line.pid);
      if (typeof line.at !== "string" || isNaN(Date.parse(line.at))) throw new Error("at: " + line.at);
      // No active run: bookkeeping stays silent, dispatch still succeeds.
      const tmp2 = mkdtempSync(join(tmpdir(), "gk-dispatch-"));
      const r2 = await dispatch({ agent: "debugger", objective: "x", cwd: tmp2 });
      if (!r2.ok) throw new Error("dispatch without active run failed: " + r2.output);
      console.log("OK");
    `;
    const proc = Bun.spawnSync(["bun", "-e", script], {
      cwd: ROOT,
      env: { ...process.env, GK_ROOT: ROOT },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.stdout.toString().trim()).toBe("OK");
  });
});
