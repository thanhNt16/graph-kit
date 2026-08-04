import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { renderClaudeSkills } from "../adapters/claude.js";
import { GraphKitError } from "../errors.js";
import { validateTemplate } from "../runtime/validation.js";
import { type InstallOptions, installTemplate, removeOwnedPaths, validateOwnedPath } from "../templates/installer.js";
import { loadTemplate } from "../templates/loader.js";
import { checksumFile } from "../templates/manifest.js";
import {
  allRegistryEntries,
  type InstallScope,
  readRegistry,
  updateRegistryUnlocked,
  withInstallLock,
} from "../templates/registry.js";

function base(scope: InstallScope, cwd: string, home: string) {
  return scope === "global" ? home : cwd;
}
function templateBase(scope: InstallScope, cwd: string, home: string) {
  return join(base(scope, cwd, home), ".graphkit", "templates");
}
export interface TemplateInfo {
  name: string;
  version: string;
  directory: string;
  scope?: InstallScope;
}

export async function inspectTemplate(directory: string) {
  const loaded = await loadTemplate(directory);
  return { manifest: loaded.manifest, issues: validateTemplate(loaded) };
}
export async function renderClaudeSkillsForTemplate(directory: string) {
  return renderClaudeSkills(await loadTemplate(directory));
}
export { renderClaudeSkills };

export async function listTemplates(cwd = process.cwd(), home = homedir()): Promise<TemplateInfo[]> {
  const entries = await allRegistryEntries(cwd, home);
  return entries.map(
    (e): TemplateInfo => ({
      name: e.name,
      version: e.version,
      directory: join(templateBase(e.scope, cwd, home), `${e.name}@${e.version}`),
      scope: e.scope,
    }),
  );
}

export async function newTemplate(directory: string, name = "new-template", version = "1.0.0") {
  await mkdir(join(directory, "schemas"), { recursive: true });
  await mkdir(join(directory, "skills", "worker"), { recursive: true });
  const manifest = [
    `name: ${name}`,
    `version: ${version}`,
    "apiVersion: graphkit.dev/v1alpha1",
    "harness: claude",
    "",
  ].join("\n");
  const workflow = [
    "apiVersion: graphkit.dev/v1alpha1",
    "kind: Workflow",
    `metadata: { name: ${name} }`,
    "limits: { max_iterations: 1, max_workers: 1 }",
    "state: { result: { merge: replace } }",
    "start: start",
    "nodes:",
    "  work:",
    "    type: agent",
    "    skill: worker",
    "    objective: Complete the task.",
    "    output: { schema: schemas/result.schema.json, save_as: result }",
    "  complete: { type: graph, operation: complete-task }",
    "edges:",
    "  - { from: start, to: work }",
    "  - { from: work, to: complete }",
    "terminal:",
    "  - { node: complete, verdict: passed }",
    "",
  ].join("\n");
  await writeFile(join(directory, "template.yaml"), manifest);
  await writeFile(join(directory, "workflow.yaml"), workflow);
  await writeFile(
    join(directory, "schemas", "result.schema.json"),
    JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
        additionalProperties: false,
      },
      null,
      2,
    ),
  );
  await writeFile(join(directory, "skills", "worker", "SKILL.md"), "# worker\n");
  return directory;
}

export async function diffTemplate(name: string, version: string, options: InstallOptions = {}) {
  const scope = options.scope ?? "project";
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  return withInstallLock(home, async () => {
    const entry = (await readRegistry(scope, cwd, home)).entries.find((e) => e.name === name && e.version === version);
    if (!entry) throw new GraphKitError("SCHEMA_VIOLATION", `template ${name}@${version} is not installed`);
    const modified: string[] = [];
    for (const path of entry.ownedPaths) {
      await validateOwnedPath(path, scope, cwd, home, entry.name, entry.version);
      try {
        if ((await checksumFile(path)) !== entry.targetChecksums[path]) modified.push(path);
      } catch {
        modified.push(path);
      }
    }
    return { modified, ownedPaths: entry.ownedPaths, targetChecksums: entry.targetChecksums };
  });
}

export async function updateTemplate(source: string, options: InstallOptions = {}) {
  return installTemplate(source, options);
}

export async function removeTemplate(name: string, version: string, options: InstallOptions = {}) {
  const scope = options.scope ?? "project";
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  return withInstallLock(home, async () => {
    const entry = (await readRegistry(scope, cwd, home)).entries.find((e) => e.name === name && e.version === version);
    if (!entry) return { removed: [], modified: [] };
    const modified: string[] = [];
    for (const path of entry.ownedPaths) {
      await validateOwnedPath(path, scope, cwd, home, entry.name, entry.version);
      try {
        if ((await checksumFile(path)) !== entry.targetChecksums[path]) modified.push(path);
      } catch {
        modified.push(path);
      }
    }
    if (modified.length && !options.force)
      throw new GraphKitError("MODIFIED_TARGET", "refusing to remove modified template targets", true, modified);
    if (!options.dryRun) {
      await removeOwnedPaths(entry.ownedPaths, scope, cwd, home, entry.name, entry.version);
      const removed = [...entry.ownedPaths];
      await updateRegistryUnlocked(
        scope,
        (r) => ({
          entries: r.entries.filter(
            (e) => !(e.name === entry.name && e.version === entry.version && e.scope === entry.scope),
          ),
        }),
        cwd,
        home,
      );
      return { removed, modified };
    }
    return { removed: entry.ownedPaths, modified };
  });
}

export async function lookupTemplate(name: string, version: string, cwd = process.cwd(), home = homedir()) {
  const all = await allRegistryEntries(cwd, home);
  const hit =
    all.find((e) => e.scope === "project" && e.name === name && e.version === version) ??
    all.find((e) => e.name === name && e.version === version);
  return hit ? join(templateBase(hit.scope, cwd, home), `${name}@${version}`) : undefined;
}
