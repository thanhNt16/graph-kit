import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type RenderedSkill, renderClaudeSkills } from "../adapters/claude.js";
import { GraphKitError } from "../errors.js";
import { withDirectoryLock } from "../shared/lock.js";
import { safeResolve } from "../shared/paths.js";
import { type LoadedTemplate, loadTemplate } from "./loader.js";
import { checksumFile, templateChecksum } from "./manifest.js";
import { type InstallScope, type RegistryEntry, registryPath, updateRegistryUnlocked } from "./registry.js";

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

const realFs = { mkdir, cp, rm, writeFile, lstat };
let ops = realFs;
let registryUpdateOp = updateRegistryUnlocked;
export function setRegistryUpdateOpForTest(next: typeof updateRegistryUnlocked): () => void {
  const old = registryUpdateOp;
  registryUpdateOp = next;
  return () => {
    registryUpdateOp = old;
  };
}
export function setInstallerOpsForTest(next: Partial<typeof realFs>): () => void {
  const old = ops;
  ops = { ...ops, ...next };
  return () => {
    ops = old;
  };
}
export function installerOpsForTest(): typeof realFs {
  return ops;
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
function fail(message: string): never {
  throw new GraphKitError("UNSAFE_PATH", message);
}

export async function buildPackage(source: string): Promise<Built> {
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
    sourceChecksum: await templateChecksum(source),
  };
}

async function validateTarget(dest: string, baseDir: string): Promise<void> {
  const rel = relative(resolve(baseDir), resolve(dest));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) fail(`target escapes base: ${dest}`);
  const parts = rel.split(sep);
  let current = resolve(baseDir);
  for (const part of parts) {
    current = join(current, part);
    try {
      const st = await ops.lstat(current);
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
    await ops.mkdir(tBase, { recursive: true });
    await ops.mkdir(sBase, { recursive: true });
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
    const st = await ops.lstat(path);
    if (st.isSymbolicLink() || st.isDirectory()) fail(`unsafe target: ${path}`);
    return { exists: true, data: await readFile(path) };
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { exists: false };
    throw e;
  }
}
async function restore(path: string, snap: Snapshot, baseDir: string) {
  await validateTarget(path, baseDir);
  if (!snap.exists) await ops.rm(path, { force: true });
  else {
    await ops.mkdir(dirname(path), { recursive: true });
    await ops.writeFile(path, snap.data ?? new Uint8Array());
  }
}

export async function installTemplate(
  source: string,
  options: InstallOptions = {},
): Promise<
  | InstallResult
  | { dryRun: true; name: string; version: string; scope: InstallScope; ownedPaths: string[]; changedPaths: string[] }
> {
  const scope = options.scope ?? "project",
    cwd = resolve(options.cwd ?? process.cwd()),
    home = resolve(options.home ?? process.env.HOME ?? homedir()),
    build = await buildPackage(source),
    lockDir = join(home, ".graphkit");
  await mkdir(lockDir, { recursive: true });
  return withDirectoryLock(lockDir, async () => {
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
        dryRun: true,
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
        await ops.mkdir(dirname(p.dest), { recursive: true });
        // Re-check after mkdir: a parent may have been swapped for a symlink
        // between the first check and the write.
        await validateTarget(p.dest, p.base);
        await ops.cp(p.staged, p.dest);
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
      await registryUpdateOp(
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
export async function removeOwnedPaths(
  ownedPaths: string[],
  scope: InstallScope,
  cwd: string,
  home: string,
  name = "",
  version = "",
): Promise<void> {
  for (const path of ownedPaths) {
    await validateOwnedPath(path, scope, cwd, home, name, version);
    await ops.rm(path, { force: true });
  }
  await cleanup(scope, cwd, home);
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
  for (const root of [templateBase(scope, cwd, home), skillBase(scope, cwd, home)]) {
    await pruneEmpty(root);
  }
}
