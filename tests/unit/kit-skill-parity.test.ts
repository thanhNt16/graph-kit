import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { generateKit, HOST_IDS } from "../../scripts/gen-kits.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CORE = join(ROOT, "kits", "_core");
const TMP = join(import.meta.dir, ".tmp-kit-parity");

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const host of HOST_IDS) generateKit(host, TMP);
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function skillNames(host: string): string[] {
  return readdirSync(join(TMP, host, "skills"))
    .filter((d) => existsSync(join(TMP, host, "skills", d, "SKILL.md")))
    .sort();
}

function coreSkillNames(): string[] {
  return readdirSync(join(CORE, "skills"))
    .filter((d) => existsSync(join(CORE, "skills", d, "SKILL.md")))
    .sort();
}

function skillMd(host: string, skill: string): string {
  return readFileSync(join(TMP, host, "skills", skill, "SKILL.md"), "utf8");
}

describe("generated kit parity (claude + pi from kits/_core)", () => {
  test("every host exposes the full _core skill set", () => {
    const core = coreSkillNames();
    expect(core.length).toBeGreaterThan(0);
    for (const host of HOST_IDS) {
      const skills = skillNames(host);
      for (const skill of core) expect(skills, `${host} missing skill ${skill}`).toContain(skill);
    }
  });

  test("skill names in frontmatter match their directory", () => {
    for (const host of HOST_IDS) {
      for (const skill of skillNames(host)) {
        const m = skillMd(host, skill).match(/^name:\s*(.*)$/m);
        const name = m?.[1].trim() ?? "";
        const expected = host === "claude" ? skill.replace("gk-", "gk:") : skill;
        expect(name, `${host}/${skill} frontmatter name`).toBe(expected);
      }
    }
  });

  test("dash-form hosts never use the colon form and vice versa", () => {
    for (const host of HOST_IDS) {
      const colon = host === "claude";
      for (const skill of skillNames(host)) {
        if (!skill.startsWith("gk-")) continue;
        const name =
          skillMd(host, skill)
            .match(/^name:\s*(.*)$/m)?.[1]
            .trim() ?? "";
        expect(name.includes(":"), `${host}/${skill}`).toBe(colon);
      }
    }
  });

  test("non-pi kits carry no stale .omp/ path references", () => {
    for (const host of HOST_IDS) {
      if (host === "pi") continue;
      for (const skill of skillNames(host)) {
        expect(skillMd(host, skill), `${host}/${skill}`).not.toContain(".omp/");
      }
    }
  });

  test("non-claude kits carry no stale .claude/ path references in skills", () => {
    for (const host of HOST_IDS) {
      if (host === "claude") continue;
      for (const skill of skillNames(host)) {
        expect(skillMd(host, skill), `${host}/${skill}`).not.toContain(".claude/");
      }
    }
  });

  test("every host ships all core agents in its native format", () => {
    const slugs = readdirSync(join(CORE, "agents"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    expect(slugs.length).toBeGreaterThan(0);
    for (const host of HOST_IDS) {
      const dir = join(TMP, host, "agents");
      for (const slug of slugs) expect(existsSync(join(dir, `${slug}.md`)), `${host}/${slug}.md`).toBe(true);
    }
  });

  test("claude ships rules-dir files; pi carries the AGENTS.md rules sections", () => {
    for (const rule of ["agent-binding", "graph-authority", "topology-routing"]) {
      expect(existsSync(join(TMP, "claude", "rules", `${rule}.md`)), `claude/${rule}.md`).toBe(true);
    }
    const raw = readFileSync(join(TMP, "pi", "rules-section.md"), "utf8");
    for (const rule of ["agent-binding", "graph-authority", "topology-routing"]) {
      expect(raw, `pi rules-section contains ${rule}`).toContain(rule);
    }
  });

  test("pi target output is a verbatim materialization of _core (modulo active-install rewrite)", () => {
    for (const skill of coreSkillNames()) {
      const core = readFileSync(join(CORE, "skills", skill, "SKILL.md"), "utf8");
      // Documented seeding artifact: _core says "active Cursor installation"
      // where every host (pi included) means its own product.
      expect(skillMd("pi", skill)).toBe(core.replace("active Cursor installation", "active pi installation"));
    }
  });

  test("no host references the removed bundled viewer", () => {
    for (const host of HOST_IDS) {
      expect(skillMd(host, "gk-visualize")).not.toContain("Bundled live viewer");
      expect(skillMd(host, "gk-visualize")).not.toContain("viewer/server.mjs");
    }
  });

  test("host-only skill files are preserved (gk-visualize/references)", () => {
    for (const host of HOST_IDS) {
      expect(existsSync(join(TMP, host, "skills", "gk-visualize", "references", "graph-palette.md")), host).toBe(true);
    }
  });
});
