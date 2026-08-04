import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type RenderedSkill, renderClaudeSkills } from "../adapters/claude.js";
import { GraphKitError } from "../errors.js";
import { safeResolve } from "../shared/paths.js";
import { type LoadedTemplate, loadTemplate } from "./loader.js";
import { checksumFile, templateChecksum } from "./manifest.js";
import { type InstallScope, type RegistryEntry, updateRegistry } from "./registry.js";

export interface InstallOptions {
  scope?: InstallScope;
  cwd?: string;
  home?: string;
  force?: boolean;
  dryRun?: boolean;
}
export interface InstallResult {
  name: string;
  version: string;
  scope: InstallScope;
  ownedPaths: string[];
  targetChecksums: Record<string, string>;
  sourceChecksum: string;
  installSource: string;
}
function base(scope: InstallScope, cwd: string, home: string) {
  return scope === "global" ? home : cwd;
}
function templateBase(scope: InstallScope, cwd: string, home: string) {
  return join(base(scope, cwd, home), ".graphkit", "templates");
}
function skillBase(scope: InstallScope, cwd: string, home: string) {
  return join(base(scope, cwd, home), ".claude", "skills");
}
interface Built {
  loaded: LoadedTemplate;
  files: string[];
  skills: RenderedSkill[];
  sourceChecksum: string;
}
interface Stage {
  staged: string;
  dest: string;
  newContent: string;
}

export async function buildPackage(source: string): Promise<Built> {
  const loaded = await loadTemplate(source),
    files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(await safeResolve(source, dir || "."), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new GraphKitError("UNSAFE_PATH", `symlink rejected: ${rel}`);
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile()) files.push(rel);
    }
  }
  await walk("");
  return {
    loaded,
    files: files.sort(),
    skills: await renderClaudeSkills(loaded),
    sourceChecksum: await templateChecksum(source),
  };
}

/** Compute logical dest paths, rejecting traversal and symlink escapes. */
async function destPaths(build: Built, scope: InstallScope, cwd: string, home: string): Promise<string[]> {
  const tBase = templateBase(scope, cwd, home);
  const sBase = skillBase(scope, cwd, home);
  const rels = [
    ...build.files.map((rel) => `${build.loaded.manifest.name}@${build.loaded.manifest.version}/${rel}`),
    ...build.skills.map((skill) => skill.relativePath),
  ];
  const out: string[] = [];
  for (const rel of rels) {
    const logical = join(
      scope === "global" ? home : cwd,
      rel.startsWith("graphkit-") ? ".claude/skills" : ".graphkit/templates",
      rel,
    );
    // Traversal / absolute / encoded containment via safeResolve on the base.
    const baseDir = rel.startsWith("graphkit-") ? sBase : tBase;
    await safeResolve(baseDir, rel);
    // Symlink-escape: the deepest existing ancestor of the destination must stay under the base.
    await assertUnder(baseDir, logical);
    out.push(logical);
  }
  return out;
}

/** Realpath the deepest existing ancestor of `path`, preserving any missing suffix. */
async function realpathOfExisting(path: string): Promise<string> {
  let current = path;
  const missing: string[] = [];
  for (;;) {
    try {
      const resolved = await realpath(current);
      return missing.length ? join(resolved, ...missing.reverse()) : resolved;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new GraphKitError("UNSAFE_PATH", `no existing ancestor for ${path}`);
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}
async function assertUnder(baseDir: string, target: string): Promise<void> {
  const realBase = await realpathOfExisting(baseDir);
  const realTarget = await realpathOfExisting(target);
  const rel = relative(realBase, realTarget);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new GraphKitError("UNSAFE_PATH", `symlink escape at ${target}`);
}
async function stage(build: Built, scope: InstallScope, cwd: string, home: string, dryRun = false): Promise<Stage[]> {
  if (dryRun) {
    const dests = await destPaths(build, scope, cwd, home);
    return dests.map((dest) => ({ staged: "", dest, newContent: "" }));
  }
  const staging = await mkdtemp(join(base(scope, cwd, home), `.gk-install-${process.pid}-`)),
    out: Stage[] = [];
  const dests = await destPaths(build, scope, cwd, home);
  const sourceFiles = build.files;
  const skillFiles = build.skills;
  let i = 0;
  for (const rel of sourceFiles) {
    const staged = join(staging, rel);
    await mkdir(dirname(staged), { recursive: true });
    await cp(await safeResolve(build.loaded.directory, rel), staged);
    out.push({ staged, dest: dests[i], newContent: await readFile(staged, "utf8") });
    i++;
  }
  for (const skill of skillFiles) {
    const staged = join(staging, skill.relativePath);
    await mkdir(dirname(staged), { recursive: true });
    await writeFile(staged, skill.content);
    out.push({ staged, dest: dests[i], newContent: skill.content });
    i++;
  }
  // Validate the fully staged template renders and references resolve before touching targets.
  await loadTemplate(staging);
  return out;
}

export async function installTemplate(
  source: string,
  options: InstallOptions = {},
): Promise<InstallResult | { dryRun: true; name: string; version: string; scope: InstallScope; ownedPaths: string[] }> {
  const scope = options.scope ?? "project",
    cwd = options.cwd ?? process.cwd(),
    home = options.home ?? process.env.HOME ?? process.cwd(),
    build = await buildPackage(source),
    pairs = await stage(build, scope, cwd, home, options.dryRun === true),
    dests = pairs.map((p) => p.dest);
  if (options.dryRun)
    return {
      dryRun: true,
      name: build.loaded.manifest.name,
      version: build.loaded.manifest.version,
      scope,
      ownedPaths: dests,
    };
  // Snapshot current target contents for rollback; refuse non-force writes to differing files.
  const snapshots = new Map<string, string | undefined>(),
    promoted: string[] = [],
    checksums: Record<string, string> = {};
  for (const pair of pairs) {
    let current: string | undefined;
    try {
      current = await readFile(pair.dest, "utf8");
    } catch {
      current = undefined;
    }
    snapshots.set(pair.dest, current);
    if (current !== undefined && !options.force && current !== pair.newContent)
      throw new GraphKitError("MODIFIED_TARGET", `refusing to overwrite modified target: ${pair.dest}`, true);
  }
  try {
    for (const pair of pairs) {
      await mkdir(dirname(pair.dest), { recursive: true });
      await cp(pair.staged, pair.dest);
      promoted.push(pair.dest);
      checksums[pair.dest] = await checksumFile(pair.dest);
    }
  } catch (error) {
    for (const p of [...promoted].reverse()) {
      const old = snapshots.get(p);
      if (old === undefined) await rm(p, { force: true });
      else {
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, old);
      }
    }
    throw error;
  }
  const entry: RegistryEntry = {
    name: build.loaded.manifest.name,
    version: build.loaded.manifest.version,
    scope,
    installSource: resolve(source),
    sourceChecksum: build.sourceChecksum,
    targetChecksums: checksums,
    ownedPaths: dests,
  };
  await updateRegistry(
    scope,
    (r) => ({ entries: [...r.entries.filter((e) => !(e.name === entry.name && e.version === entry.version)), entry] }),
    cwd,
    home,
  );
  return entry;
}

export async function removeOwnedPaths(
  ownedPaths: string[],
  scope: InstallScope,
  cwd: string,
  home: string,
): Promise<void> {
  const tBase = templateBase(scope, cwd, home);
  const sBase = skillBase(scope, cwd, home);
  await Promise.all(ownedPaths.map((path) => rm(path, { force: true }).catch(() => {})));
  // Recursively remove any now-empty template and skill directory trees.
  for (const base of [tBase, sBase]) {
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(base, entry);
      try {
        if ((await stat(child)).isDirectory()) {
          const remaining = await readdir(child);
          // If any files survive, skip
          const hasFiles = (
            await Promise.all(
              remaining.map(async (e) => {
                try {
                  return (await stat(join(child, e))).isFile();
                } catch {
                  return false;
                }
              }),
            )
          ).some(Boolean);
          if (!hasFiles && remaining.every((e) => e === (undefined as unknown as string))) {
          } // placeholder
          if (!hasFiles) await rm(child, { recursive: true, force: true });
        }
      } catch {}
    }
  }
}
