import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeSkills } from "../../src/adapters/claude.js";
import {
  diffTemplate,
  listTemplates,
  lookupTemplate,
  newTemplate,
  removeTemplate,
  updateTemplate,
} from "../../src/commands/template.js";
import { installTemplate } from "../../src/templates/installer.js";
import { loadTemplate } from "../../src/templates/loader.js";
import { readRegistry } from "../../src/templates/registry.js";

const fixture = join(import.meta.dir, "..", "fixtures", "valid-chain");
let cwd = "";
let home = "";
let scope: "project" | "global" = "project";

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "gk-test-cwd-"));
  home = await mkdtemp(join(tmpdir(), "gk-test-home-"));
  scope = "project";
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function opts() {
  return { cwd, home, scope };
}

describe("Claude skill rendering", () => {
  test("renders strict SKILL.md frontmatter and authority protocol", async () => {
    const loaded = await loadTemplate(fixture);
    const skills = await renderClaudeSkills(loaded);
    expect(skills.length).toBeGreaterThan(0);
    const skill = skills[0];
    expect(skill.content).toContain("name: graphkit-worker");
    expect(skill.content).toContain("user-invocable: true");
    expect(skill.content).toContain("when_to_use:");
    expect(skill.content).toContain("gk workflow next");
    expect(skill.content).toContain("gk workflow submit");
    expect(skill.content).toContain("gk workflow execute");
    expect(skill.content).toContain("Never infer edges");
    expect(skill.content).toContain("never exceed the returned concurrency ceiling");
  });
});

describe("installation", () => {
  test("installs project files and records owned paths", async () => {
    const result = await installTemplate(fixture, opts());
    const root = join(cwd, ".graphkit", "templates", "valid-chain@1.0.0");
    expect(result.ownedPaths.length).toBeGreaterThan(0);
    expect(await readFile(join(root, "template.yaml"), "utf8")).toContain("name: valid-chain");
    const skillDir = await readdir(join(cwd, ".claude", "skills", "graphkit-worker"));
    expect(skillDir).toContain("SKILL.md");
    const registry = await readRegistry("project", cwd, home);
    expect(registry.entries).toHaveLength(1);
    const entry = registry.entries[0];
    expect(entry.scope).toBe("project");
    expect(entry.name).toBe("valid-chain");
    expect(entry.version).toBe("1.0.0");
    expect(entry.sourceChecksum).toBeTruthy();
    expect(Object.keys(entry.targetChecksums).length).toBe(entry.ownedPaths.length);
    for (const path of entry.ownedPaths) expect(path).toContain(cwd);
  });
  test("installs globally under HOME", async () => {
    const result = await installTemplate(fixture, { ...opts(), scope: "global" });
    expect(result.ownedPaths[0]).toContain(home);
    expect(
      await readFile(join(home, ".graphkit", "templates", "valid-chain@1.0.0", "template.yaml"), "utf8"),
    ).toContain("name: valid-chain");
    const registry = await readRegistry("global", cwd, home);
    expect(registry.entries[0].scope).toBe("global");
  });
  test("project scope wins lookup collision", async () => {
    await installTemplate(fixture, { ...opts(), scope: "global" });
    await installTemplate(fixture, opts());
    const dir = await lookupTemplate("valid-chain", "1.0.0", cwd, home);
    expect(dir).toBe(join(cwd, ".graphkit", "templates", "valid-chain@1.0.0"));
  });
  test("dry-run changes nothing", async () => {
    const before = await readdir(cwd);
    const result = await installTemplate(fixture, { ...opts(), dryRun: true });
    if (!("dryRun" in result)) throw new Error("expected dryRun result");
    expect(result.dryRun).toBe(true);
    expect(await readdir(cwd)).toEqual(before);
    expect((await readRegistry("project", cwd, home)).entries).toHaveLength(0);
  });
  test("rejects traversal in manifest name through safeResolve", async () => {
    const evil = await mkdtemp(join(tmpdir(), "gk-evil-"));
    await cp(fixture, evil, { recursive: true });
    await writeFile(
      join(evil, "template.yaml"),
      "name: ..%2Fescape" +
        "\n" +
        "version: 1.0.0" +
        "\n" +
        "apiVersion: graphkit.dev/v1alpha1" +
        "\n" +
        "harness: claude" +
        "\n",
    );
    await expect(installTemplate(evil, opts())).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });
  test("rejects symlink escape at install target", async () => {
    const outside = await mkdtemp(join(tmpdir(), "gk-outside-"));
    await mkdir(join(cwd, ".graphkit", "templates"), { recursive: true });
    await symlink(outside, join(cwd, ".graphkit", "templates", "valid-chain@1.0.0"));
    await expect(installTemplate(fixture, opts())).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });
});

describe("lifecycle safety", () => {
  test("diff detects a user edit", async () => {
    await installTemplate(fixture, opts());
    const target = join(cwd, ".graphkit", "templates", "valid-chain@1.0.0", "workflow.yaml");
    await writeFile(target, `${await readFile(target, "utf8")}\n# user edit\n`);
    const diff = await diffTemplate("valid-chain", "1.0.0", opts());
    expect(diff.modified).toEqual([target]);
  });
  test("update refuses MODIFIED_TARGET without force", async () => {
    await installTemplate(fixture, opts());
    const target = join(cwd, ".graphkit", "templates", "valid-chain@1.0.0", "workflow.yaml");
    await writeFile(target, `${await readFile(target, "utf8")}\n# edit\n`);
    await expect(updateTemplate(fixture, opts())).rejects.toMatchObject({ code: "MODIFIED_TARGET" });
  });
  test("force updates a modified target", async () => {
    await installTemplate(fixture, opts());
    const target = join(cwd, ".graphkit", "templates", "valid-chain@1.0.0", "workflow.yaml");
    await writeFile(target, "edited" + "\n");
    await updateTemplate(fixture, { ...opts(), force: true });
    expect(await readFile(target, "utf8")).toContain("name: valid-chain");
    expect((await diffTemplate("valid-chain", "1.0.0", opts())).modified).toEqual([]);
  });
  test("remove deletes only owned paths", async () => {
    const result = await installTemplate(fixture, opts());
    const foreign = join(cwd, ".claude", "skills", "graphkit-worker", "user-note.md");
    await writeFile(
      foreign,
      `keep me
`,
    );
    const removed = await removeTemplate("valid-chain", "1.0.0", opts());
    expect(removed.removed.length).toBe(result.ownedPaths.length);
    expect(await readFile(foreign, "utf8")).toBe(`keep me
`);
    expect(await readdir(join(cwd, ".graphkit", "templates"))).toEqual([]);
    expect((await readRegistry("project", cwd, home)).entries).toHaveLength(0);
  });
  test("rollback restores snapshots in reverse on mid-promotion failure", async () => {
    const root = join(cwd, ".graphkit", "templates", "valid-chain@1.0.0");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "template.yaml"), "OLD" + "\n");
    await mkdir(join(cwd, ".claude", "skills", "graphkit-worker"), { recursive: true });
    await mkdir(join(cwd, ".claude", "skills", "graphkit-worker", "SKILL.md"), { recursive: true });
    await expect(installTemplate(fixture, { ...opts(), force: true })).rejects.toThrow();
    expect(await readFile(join(root, "template.yaml"), "utf8")).toBe("OLD" + "\n");
    expect((await readRegistry("project", cwd, home)).entries).toHaveLength(0);
    const dirEntries = await readdir(join(cwd, ".graphkit", "templates"));
    expect(dirEntries).toEqual(["valid-chain@1.0.0"]);
  });
});

describe("template scaffolding", () => {
  test("newTemplate creates the smallest valid chain fixture", async () => {
    const dir = await newTemplate(join(cwd, "templates", "mine"));
    const loaded = await loadTemplate(dir);
    expect(loaded.manifest.name).toBe("new-template");
    expect(loaded.workflow.nodes.work.type).toBe("agent");
    await expect(installTemplate(dir, opts())).resolves.toBeTruthy();
  });
  test("listTemplates surfaces installed entries", async () => {
    await installTemplate(fixture, opts());
    const listed = await listTemplates(cwd, home);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("valid-chain");
    expect(listed[0].scope).toBe("project");
  });
});
