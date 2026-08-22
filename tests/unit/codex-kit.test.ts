import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installKit } from "../../src/cli/commands/kit.js";

const ROOT = join(import.meta.dir, "..", "..");

describe("codex kit", () => {
  const agentsDir = join(ROOT, "kits", "codex", "agents");

  test("8 agents ship as parseable TOML with required fields", () => {
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".toml"));
    expect(files.length).toBe(8);
    for (const f of files) {
      const raw = readFileSync(join(agentsDir, f), "utf8");
      expect(raw.match(/^name\s*=\s*"(.+)"/m), `${f} name`).toBeTruthy();
      expect(raw.match(/^description\s*=\s*"/m), `${f} description`).toBeTruthy();
      expect(raw.includes("developer_instructions"), `${f} instructions`).toBe(true);
    }
  });

  test("agent names are underscored and unique", () => {
    const names = readdirSync(agentsDir)
      .filter((f) => f.endsWith(".toml"))
      .map((f) => readFileSync(join(agentsDir, f), "utf8").match(/^name\s*=\s*"(.+)"/m)?.[1]);
    for (const n of names) expect(n).toMatch(/^[a-z_]+$/);
    expect(new Set(names).size).toBe(8);
  });

  test("read-only agents get read-only sandbox, writers get workspace-write", () => {
    const readOnly = ["code-reviewer.toml", "ui-ux-researcher.toml", "agents-orchestrator.toml", "memory-curator.toml"];
    const writers = ["data-engineer.toml", "qa-engineer.toml", "software-architect.toml", "document-generator.toml"];
    for (const f of readOnly) {
      expect(readFileSync(join(agentsDir, f), "utf8")).toContain('sandbox_mode = "read-only"');
    }
    for (const f of writers) {
      expect(readFileSync(join(agentsDir, f), "utf8")).toContain('sandbox_mode = "workspace-write"');
    }
  });

  test("model tiers match TARGET_MODEL_DEFAULTS.codex", () => {
    const raw = (f: string) => readFileSync(join(agentsDir, f), "utf8");
    expect(raw("software-architect.toml")).toContain('model = "gpt-5.4"');
    expect(raw("software-architect.toml")).toContain('model_reasoning_effort = "high"');
    expect(raw("code-reviewer.toml")).toContain('model = "gpt-5.3-codex-spark"');
    expect(raw("qa-engineer.toml")).toContain('model_reasoning_effort = "medium"');
  });

  test("skills match cursor set (no compile/run)", () => {
    const codex = readdirSync(join(ROOT, "kits", "codex", "skills")).sort();
    const cursor = readdirSync(join(ROOT, "kits", "cursor", "skills")).sort();
    expect(codex).toEqual(cursor);
  });

  test("gk-execute carries spawn protocol and wave barrier rule", () => {
    const raw = readFileSync(join(ROOT, "kits", "codex", "skills", "gk-execute", "SKILL.md"), "utf8");
    expect(raw).toContain("## Dispatching a wave (Codex)");
    expect(raw).toContain("Wave barrier rule");
    expect(raw).toContain("gk graph waves graph.yaml --json");
    expect(raw).not.toContain("/gk:");
  });

  test("no stale .claude/.cursor path references in skills", () => {
    const dir = join(ROOT, "kits", "codex", "skills");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(md|py)$/.test(e.name)) {
          const raw = readFileSync(p, "utf8");
          if (raw.includes(".claude") || raw.includes(".cursor")) offenders.push(p);
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });

  test("rules section carries all three rule headings", () => {
    const raw = readFileSync(join(ROOT, "kits", "codex", "rules-section.md"), "utf8");
    expect(raw).toContain("agent-binding");
    expect(raw).toContain("graph-authority");
    expect(raw).toContain("topology-routing");
  });
});

describe("installKit AGENTS.md rules section (codex)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = join(tmpdir(), `gk-codex-kit-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("appends marked rules section to existing AGENTS.md", () => {
    writeFileSync(join(tmp, "AGENTS.md"), "# Project rules\n\nBe nice.\n");
    installKit(tmp, false, "codex");
    const raw = readFileSync(join(tmp, "AGENTS.md"), "utf8");
    expect(raw).toContain("# Project rules");
    expect(raw).toContain("<!-- graphkit:start -->");
    expect(raw).toContain("<!-- graphkit:end -->");
    expect(raw).toContain("graph-authority");
  });

  test("idempotent on re-init (marker present → no duplicate append)", () => {
    installKit(tmp, false, "codex");
    const once = readFileSync(join(tmp, "AGENTS.md"), "utf8");
    installKit(tmp, false, "codex");
    const twice = readFileSync(join(tmp, "AGENTS.md"), "utf8");
    expect(twice).toBe(once);
    expect(twice.split("<!-- graphkit:start -->").length - 1).toBe(1);
  });
});
