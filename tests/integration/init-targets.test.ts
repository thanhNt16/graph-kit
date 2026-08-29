import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TMP = join(import.meta.dir, "..", "..", ".tmp-init-test");
const KITS = join(import.meta.dir, "..", "..", "kits");

function initTmp(target: string): string {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  execSync(`bun run ${join(process.cwd(), "dist", "index.js")} init --target ${target}`, {
    cwd: TMP,
    env: { ...process.env, GK_KIT_DIR: join(process.cwd(), "kits", target) },
  });
  return TMP;
}

describe("init per target", () => {
  test("opencode tree", () => {
    initTmp("opencode");
    expect(existsSync(join(TMP, ".opencode", "agent"))).toBe(true);
    expect(existsSync(join(TMP, ".opencode", "skill"))).toBe(true);
    expect(existsSync(join(TMP, ".opencode", "plugins", "gk.ts"))).toBe(true);
    expect(existsSync(join(TMP, ".opencode", "command"))).toBe(true);
    expect(existsSync(join(TMP, ".opencode", "metadata.json"))).toBe(true);
  });

  test.skipIf(!existsSync(join(KITS, "codex")))("codex tree — agents toml + skills land in .agents/skills", () => {
    initTmp("codex");
    expect(existsSync(join(TMP, ".codex", "agents"))).toBe(true);
    expect(existsSync(join(TMP, ".agents", "skills"))).toBe(true);
  });

  test("pi/omp tree", () => {
    initTmp("pi");
    expect(existsSync(join(TMP, ".omp", "extensions", "gk-subagent.ts"))).toBe(true);
    expect(existsSync(join(TMP, ".omp", "skills", "gk-status", "SKILL.md"))).toBe(true);
    expect(existsSync(join(TMP, ".omp", "agents"))).toBe(true);
    expect(existsSync(join(TMP, ".omp", "prompts", "gk.md"))).toBe(true);
    expect(existsSync(join(TMP, "AGENTS.md"))).toBe(true);
  });

  test.skipIf(process.env.GK_TEST_OMP !== "1")("pi kit is discovered by OMP", { timeout: 120_000 }, () => {
    const output = execSync(
      'omp --print --no-session --mode text "Read skill://gk-status and print its first heading only."',
      {
        cwd: TMP,
        encoding: "utf8",
      },
    );
    expect(output).toContain("# gk status");
  });

  test("invalid target exits 1 with BAD_TARGET", () => {
    let code = 0;
    try {
      execSync(`bun run dist/index.js init --target vscode`, { encoding: "utf8", stdio: "pipe" });
    } catch (e: unknown) {
      const err = e as { status: number; stdout: string };
      code = err.status;
      expect(String(err.stdout)).toContain("BAD_TARGET");
      expect(String(err.stdout)).toContain("opencode");
    }
    expect(code).toBe(1);
  });

  test("cleanup", () => {
    rmSync(TMP, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
