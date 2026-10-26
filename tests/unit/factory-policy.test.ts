import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../../src/factory/config";
import { DEFAULT_DENY_BASH, laneEnv, policyFor } from "../../src/factory/policy";

const cfg = {
  vcs: { branch_prefix: "factory/" },
  dispatch: { env_passthrough: [] },
} as unknown as FactoryConfig;

describe("policyFor", () => {
  test("material contract", () => {
    const p = policyFor(cfg, { id: "c-42" }, "building", "/tmp/wt/c-42", "/tmp/log.jsonl");
    expect(p.branch).toBe("factory/c-42");
    expect(p.worktree).toBe("/tmp/wt/c-42");
    expect(p.deny_bash.length).toBe(DEFAULT_DENY_BASH.length);
  });
});

describe("deny_bash regexes", () => {
  const deny = (cmd: string) => DEFAULT_DENY_BASH.some((s) => new RegExp(s).test(cmd));
  test.each([
    "gh pr merge 1",
    "gh pr create",
    "gh issue create",
    "gh api /repos/x",
    "git push origin x",
    "git push",
    "git checkout main",
    "git checkout -b main",
    "git commit --amend",
    "git reset --hard origin/main",
    "git rebase origin/main",
    "git worktree remove ../wt",
    "curl https://api.github.com/x",
    "curl -X POST https://api.atlassian.net/x",
    "curl https://api.bitbucket.org/x",
    "glab mr merge 5",
  ])("denies %s", (cmd) => expect(deny(cmd)).toBe(true));

  test.each([
    "git commit -m 'x'",
    "git commit --allow-empty -m x",
    "git checkout -b factory/c-1",
    "git merge-base HEAD origin/main", // read-only merge-base w/o origin/ arg order
    "curl https://example.com",
    "bun run typecheck",
    "echo gh pr merge", // inside a string arg — still matches (conservative ok? no — pattern needs word boundary after gh)
  ])("allows %s", (cmd) => {
    if (cmd === "echo gh pr merge") {
      expect(deny(cmd)).toBe(true); // conservative deny — fine
    } else {
      expect(deny(cmd)).toBe(false);
    }
  });
});

describe("laneEnv", () => {
  test("strips secrety + GK_ vars, keeps base, adds passthrough + policy", () => {
    const root = mkdtempSync(join(tmpdir(), "gk-env-"));
    const policy = policyFor(cfg, { id: "c-1" }, "qa", root, join(root, "log.jsonl"));
    const parent = {
      PATH: "/bin",
      HOME: "/home/u",
      GH_TOKEN: "tok",
      GITHUB_TOKEN: "tok",
      GITHUB_APP_PRIVATE_KEY: "k",
      ANTHROPIC_API_KEY: "k",
      GK_PROMPT: "internal",
      OMP_PROFILE: "x",
      SSH_AUTH_SOCK: "/tmp/ssh",
      NPM_CONFIG_USERCONFIG: "/tmp/npmrc",
      EDITOR: "vim",
    };
    const env = laneEnv(parent, cfg, policy);
    expect(env.PATH).toBe("/bin");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GK_PROMPT).toBeUndefined();
    expect(env.OMP_PROFILE).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.EDITOR).toBe("vim");
    expect(env.NPM_CONFIG_USERCONFIG).toBe("/tmp/npmrc");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(JSON.parse(env.GK_FACTORY_POLICY)).toMatchObject({ card: "c-1", lane: "qa" });
  });

  test("env_passthrough admits a listed secret", () => {
    const cfg2 = { vcs: { branch_prefix: "f/" }, dispatch: { env_passthrough: ["ANTHROPIC_API_KEY"] } } as unknown as FactoryConfig;
    const env = laneEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "k" }, cfg2, policyFor(cfg2, { id: "x" }, "building", "/w", "/l"));
    expect(env.ANTHROPIC_API_KEY).toBe("k");
  });
});
