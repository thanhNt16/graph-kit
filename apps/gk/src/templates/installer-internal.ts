import type { cp, lstat } from "node:fs/promises";
import { type mkdir, mkdtemp, readdir, readFile, type rm, type writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type RenderedSkill, renderClaudeSkills } from "../adapters/claude.js";
import { GraphKitError } from "../errors.js";
import { safeResolve } from "../shared/paths.js";
import { type LoadedTemplate, loadTemplate } from "./loader.js";
import { checksumFile } from "./manifest.js";
import {
  type InstallScope,
  type RegistryEntry,
  registryPath,
  type updateRegistryUnlocked,
  withInstallLock,
} from "./registry.js";

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
export interface InstallerDeps {
  mkdir: typeof mkdir;
  cp: typeof cp;
  rm: typeof rm;
  writeFile: typeof writeFile;
  lstat: typeof lstat;
  updateRegistry: typeof updateRegistryUnlocked;
}
interface Built {
  loaded: LoadedTemplate;
  files: string[];
  skills: RenderedSkill[];
  sourceChecksum: string;
}
interface Pair {
  staged: string;
  dest: string;
  base: string;
  content: Uint8Array;
}
interface Snapshot {
  exists: boolean;
  data?: Uint8Array;
}

function fail(message: string): never {
  throw new GraphKitError("UNSAFE_PATH", message);
}

export function createInstaller(deps: InstallerDeps) {
  const { mkdir, cp, rm, writeFile, lstat, updateRegistry } = deps;

  function base(scope: InstallScope, cwd: string, home: string) {
    return scope === "global" ? home : cwd;
  }
  function templateBase(scope: InstallScope, cwd: string, home: string) {
    return join(base(scope, cwd, home), ".graphkit", "templates");
  }
  function skillBase(scope: InstallScope, cwd: string, home: string) {
    return join(base(scope, cwd, home), ".claude", "skills");
  }

  async function buildPackage(source: string): Promise<Built> {
    const loaded = await loadTemplate(source),
      files: string[] = [];
    async function walk(dir: string): Promise<void> {
      const absolute = await safeResolve(source, dir || ".");
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) fail(`symlink rejected: ${rel}`);
        if (entry.isDirectory()) await walk(rel);
        else if (entry.isFile()) files.push(rel);
      }
    }
    await walk("");
    return {
      loaded,
      files: files.sort(),
      skills: await renderClaudeSkills(loaded),
      sourceChecksum: await templateChecksumFrom(loaded.directory),
    };
  }

  async function templateChecksumFrom(directory: string): Promise<string> {
    const { templateChecksum } = await import("./manifest.js");
    return templateChecksum(directory);
  }

  async function validateTarget(dest: string, baseDir: string): Promise<void> {
    const rel = relative(resolve(baseDir), resolve(dest));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) fail(`target escapes base: ${dest}`);
    const parts = rel.split(sep);
    let current = resolve(baseDir);
    for (const part of parts) {
      current = join(current, part);
      try {
        const st = await lstat(current);
        if (st.isSymbolicLink()) fail(`symlink target: ${current}`);
        if (current !== dest && !st.isDirectory()) fail(`parent is not directory: ${current}`);
        if (current === dest && st.isDirectory()) fail(`directory collision: ${current}`);
      } catch (e) {
        if ((e as { code?: string }).code !== "ENOENT") throw e;
      }
    }
    await safeResolve(baseDir, rel);
  }

  async function pairs(build: Built, scope: InstallScope, cwd: string, home: string, dryRun = false): Promise<Pair[]> {
    const tBase = templateBase(scope, cwd, home),
      sBase = skillBase(scope, cwd, home);
    if (!dryRun) {
      await mkdir(tBase, { recursive: true });
      await mkdir(sBase, { recursive: true });
    }
    const staging = dryRun ? "" : await mkdtemp(join(base(scope, cwd, home), `.gk-install-${process.pid}-`));
    const out: Pair[] = [];
    for (const rel of build.files) {
      const dest = join(tBase, `${build.loaded.manifest.name}@${build.loaded.manifest.version}`, rel);
      await validateTarget(dest, tBase);
      const data = await readFile(await safeResolve(build.loaded.directory, rel));
      if (!dryRun) {
        const staged = join(staging, rel);
        await mkdir(dirname(staged), { recursive: true });
        await writeFile(staged, data);
        out.push({ staged, dest, base: tBase, content: data });
      } else out.push({ staged: "", dest, base: tBase, content: data });
    }
    for (const skill of build.skills) {
      const dest = join(sBase, skill.relativePath);
      await validateTarget(dest, sBase);
      const data = new TextEncoder().encode(skill.content);
      if (!dryRun) {
        const staged = join(staging, skill.relativePath);
        await mkdir(dirname(staged), { recursive: true });
        await writeFile(staged, data);
        out.push({ staged, dest, base: sBase, content: data });
      } else out.push({ staged: "", dest, base: sBase, content: data });
    }
    if (!dryRun) await loadTemplate(staging);
    return out;
  }

  async function snapshot(path: string): Promise<Snapshot> {
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink() || st.isDirectory()) fail(`unsafe target: ${path}`);
      return { exists: true, data: await readFile(path) };
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return { exists: false };
      throw e;
    }
  }
  async function restore(path: string, snap: Snapshot, baseDir: string) {
    await validateTarget(path, baseDir);
    if (!snap.exists) await rm(path, { force: true });
    else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, snap.data ?? new Uint8Array());
    }
  }

  async function installTemplate(source: string, options: InstallOptions = {}) {
    const scope = options.scope ?? "project",
      cwd = resolve(options.cwd ?? process.cwd()),
      home = resolve(options.home ?? process.env.HOME ?? process.cwd());
    const build = await buildPackage(source);
    return withInstallLock(home, async () => {
      const ps = await pairs(build, scope, cwd, home, options.dryRun === true),
        changedPaths: string[] = [],
        snapshots = new Map<string, Snapshot>();
      for (const p of ps) {
        const s = await snapshot(p.dest);
        snapshots.set(p.dest, s);
        if (s.exists && Buffer.compare(Buffer.from(s.data ?? new Uint8Array()), Buffer.from(p.content)) !== 0)
          changedPaths.push(p.dest);
      }
      if (changedPaths.length && !options.force)
        throw new GraphKitError(
          "MODIFIED_TARGET",
          `refusing to overwrite modified target: ${changedPaths[0]}`,
          true,
          changedPaths,
        );
      if (options.dryRun)
        return {
          dryRun: true as const,
          name: build.loaded.manifest.name,
          version: build.loaded.manifest.version,
          scope,
          ownedPaths: ps.map((p) => p.dest),
          changedPaths,
        };
      const registryFile = registryPath(scope, cwd, home),
        registrySnap = await snapshot(registryFile),
        promoted: Pair[] = [];
      try {
        for (const p of ps) {
          await validateTarget(p.dest, p.base);
          await mkdir(dirname(p.dest), { recursive: true });
          await validateTarget(p.dest, p.base);
          await cp(p.staged, p.dest);
          promoted.push(p);
        }
        const checksums: Record<string, string> = {};
        for (const p of ps) checksums[p.dest] = await checksumFile(p.dest);
        const entry: RegistryEntry = {
          name: build.loaded.manifest.name,
          version: build.loaded.manifest.version,
          scope,
          installSource: resolve(source),
          sourceChecksum: build.sourceChecksum,
          targetChecksums: checksums,
          ownedPaths: ps.map((p) => p.dest),
        };
        await updateRegistry(
          scope,
          (r) => ({
            entries: [...r.entries.filter((e) => !(e.name === entry.name && e.version === entry.version)), entry],
          }),
          cwd,
          home,
        );
        return entry;
      } catch (error) {
        for (const p of [...promoted].reverse())
          await restore(p.dest, snapshots.get(p.dest) ?? { exists: false }, p.base);
        await restore(registryFile, registrySnap, join(base(scope, cwd, home), ".graphkit"));
        throw error;
      } finally {
        await rm(dirname(ps[0]?.staged ?? join(base(scope, cwd, home), ".gk-install-none")), {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
    });
  }

  async function validateOwnedPath(
    path: string,
    scope: InstallScope,
    cwd: string,
    home: string,
    name: string,
    version: string,
  ): Promise<string> {
    const t = templateBase(scope, cwd, home),
      s = skillBase(scope, cwd, home),
      tr = relative(t, path),
      sr = relative(s, path);
    const allowed =
      (tr.startsWith(`${name}@${version}${sep}`) && !tr.includes(`${sep}${sep}`)) ||
      sr.startsWith(`graphkit-${name}${sep}`) ||
      sr.startsWith("graphkit-");
    if (!allowed) fail(`registry path not allowed: ${path}`);
    const b = path.startsWith(s) ? s : t;
    await validateTarget(path, b);
    return path;
  }

  async function pruneEmpty(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      const st = await lstat(p);
      if (st.isDirectory()) {
        await pruneEmpty(p);
        if ((await readdir(p)).length === 0) await rm(p, { recursive: true, force: true });
      }
    }
  }
  async function cleanup(scope: InstallScope, cwd: string, home: string) {
    for (const root of [templateBase(scope, cwd, home), skillBase(scope, cwd, home)]) await pruneEmpty(root);
  }

  async function removeOwnedPaths(
    ownedPaths: string[],
    scope: InstallScope,
    cwd: string,
    home: string,
    name = "",
    version = "",
  ) {
    for (const path of ownedPaths) {
      await validateOwnedPath(path, scope, cwd, home, name, version);
      await rm(path, { force: true });
    }
    await cleanup(scope, cwd, home);
  }

  return { installTemplate, removeOwnedPaths, validateOwnedPath };
}
