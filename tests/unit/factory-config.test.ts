import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { GraphKitError } from "../../src/errors";
import { loadFactoryConfig, parseDuration, validateFactory } from "../../src/factory/config";

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "factory", "factory.yaml");

import { readFileSync } from "node:fs";

function write(root: string, rel: string, body: string): void {
  mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function base(root: string, mutate?: (c: Record<string, unknown>) => void): string {
  const cfg = JSON.parse(JSON.stringify(YAML.parse(readFileSync(TEMPLATE, "utf8")))) as Record<string, unknown>;
  mutate?.(cfg);
  write(root, ".omp/factory.yaml", YAML.stringify(cfg));
  return join(root, ".omp", "factory.yaml");
}

/** Starter config + the skills/lane-graphs it references, laid down in a tmp root. */
function scaffold(mutate?: (c: Record<string, unknown>) => void): string {
  const root = mkdtempSync(join(tmpdir(), "gk-factory-cfg-"));
  base(root, mutate);
  for (const s of [
    "factory-intake",
    "factory-repro-check",
    "factory-build",
    "factory-dedup-ladder",
    "factory-git-sync",
    "factory-scrutiny",
    "factory-ui-journey",
    "factory-proof",
    "factory-adversarial-review",
    "factory-heresy-lint",
    "context-docs",
  ]) {
    write(root, `.omp/skills/${s}/SKILL.md`, `---\nname: ${s}\ndescription: x\n---\n`);
  }
  mkdirSync(join(root, "templates", "gallery"), { recursive: true });
  for (const g of ["factory-intake", "factory-build", "factory-qa", "factory-review"]) {
    write(root, `templates/gallery/${g}.gk.yaml`, "name: x\nnodes: {}\n");
  }
  return root;
}

describe("loadFactoryConfig", () => {
  test("starter template parses", () => {
    const root = scaffold();
    const cfg = loadFactoryConfig(root);
    expect(cfg.version).toBe(1);
    expect(cfg.lanes.building.agent).toBe("worker");
    expect(cfg.dispatch.max_rounds).toBe(3);
    expect(cfg.vcs.merge.method).toBe("squash");
  });

  test("missing file → FACTORY_CONFIG", () => {
    const root = mkdtempSync(join(tmpdir(), "gk-factory-none-"));
    expect(() => loadFactoryConfig(root)).toThrow(GraphKitError);
  });

  test("unknown key (temperature) rejected with hint-able issue", () => {
    const root = scaffold((c) => {
      (c.agents as Record<string, Record<string, unknown>>).worker.temperature = 0.2;
    });
    try {
      loadFactoryConfig(root);
      throw new Error("should fail");
    } catch (e) {
      expect(e).toBeInstanceOf(GraphKitError);
      const issues = (e as GraphKitError).details?.issues as Array<{ path: string }>;
      expect(issues.some((i) => i.path.includes("agents.worker"))).toBe(true);
    }
  });

  test("unknown provider rejected", () => {
    const root = scaffold((c) => {
      (c.board as Record<string, unknown>).provider = "azure";
    });
    expect(() => loadFactoryConfig(root)).toThrow(GraphKitError);
  });

  test("non-positive max_parallel rejected", () => {
    const root = scaffold((c) => {
      (c.dispatch as Record<string, unknown>).max_parallel = { building: 0 };
    });
    expect(() => loadFactoryConfig(root)).toThrow(GraphKitError);
  });
});

describe("validateFactory", () => {
  test("starter config validates clean (local providers)", () => {
    const root = scaffold();
    const findings = validateFactory(root, loadFactoryConfig(root), { home: join(root, "nohome") });
    expect(findings.filter((f) => f.severity !== "warn")).toEqual([]);
  });

  test("unknown skill → FACTORY_UNKNOWN_SKILL", () => {
    const root = scaffold((c) => {
      (c.agents as Record<string, Record<string, string[]>>).worker.skills = ["no-such-skill"];
    });
    const findings = validateFactory(root, loadFactoryConfig(root), { home: join(root, "nohome") });
    expect(findings.some((f) => f.check === "FACTORY_UNKNOWN_SKILL" && f.message.includes("no-such-skill"))).toBe(true);
  });

  test("unknown tool → FACTORY_UNKNOWN_TOOL", () => {
    const root = scaffold((c) => {
      (c.agents as Record<string, Record<string, string[]>>).worker.tools = ["telekinesis"];
    });
    const findings = validateFactory(root, loadFactoryConfig(root));
    expect(findings.some((f) => f.check === "FACTORY_UNKNOWN_TOOL")).toBe(true);
  });

  test("authority lint: github/task/manage_skill forbidden everywhere", () => {
    const root = scaffold((c) => {
      (c.agents as Record<string, Record<string, string[]>>).worker.tools = ["read", "github", "task"];
    });
    const findings = validateFactory(root, loadFactoryConfig(root));
    expect(findings.filter((f) => f.check === "FACTORY_AUTHORITY").length).toBe(2);
  });

  test("authority lint: write tools on qa/review lane profiles", () => {
    const root = scaffold((c) => {
      (c.agents as Record<string, Record<string, string[]>>).reviewer.tools = ["read", "write"];
    });
    const findings = validateFactory(root, loadFactoryConfig(root));
    expect(findings.some((f) => f.check === "FACTORY_AUTHORITY" && f.path === "agents.reviewer.tools")).toBe(true);
  });

  test("lane → undefined agent → FACTORY_CONFIG", () => {
    const root = scaffold((c) => {
      (c.lanes as Record<string, Record<string, string>>).building.agent = "ghost";
    });
    const findings = validateFactory(root, loadFactoryConfig(root));
    expect(findings.some((f) => f.path === "lanes.building.agent")).toBe(true);
  });

  test("github board without board.github → FACTORY_CONFIG", () => {
    const root = scaffold((c) => {
      (c.board as Record<string, unknown>).provider = "github";
      delete (c.board as Record<string, unknown>).github;
    });
    const findings = validateFactory(root, loadFactoryConfig(root));
    expect(findings.some((f) => f.path === "board.github")).toBe(true);
  });

  test("github provider without token env → FACTORY_MISSING_ENV (warn)", () => {
    const root = scaffold((c) => {
      (c.board as Record<string, unknown>).provider = "github";
      (c.board as Record<string, unknown>).github = { owner: "o", repo: "r", project_number: 1 };
    });
    const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const findings = validateFactory(root, loadFactoryConfig(root));
      const f = findings.find((f) => f.check === "FACTORY_MISSING_ENV");
      expect(f).toBeDefined();
      expect(f?.severity).toBe("warn");
    } finally {
      process.env.GH_TOKEN = saved.GH_TOKEN;
      process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN;
    }
  });
});

describe("parseDuration", () => {
  test("units", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("60s")).toBe(60_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1h")).toBe(3_600_000);
  });
  test("malformed → FACTORY_CONFIG", () => {
    expect(() => parseDuration("10x")).toThrow(GraphKitError);
  });
});
