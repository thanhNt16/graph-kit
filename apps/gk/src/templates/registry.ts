import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GraphKitError } from "../errors.js";
import { writeJsonAtomic } from "../shared/files.js";
import { withDirectoryLock } from "../shared/lock.js";

export type InstallScope = "project" | "global";
export interface RegistryEntry {
  name: string;
  version: string;
  scope: InstallScope;
  installSource: string;
  sourceChecksum: string;
  targetChecksums: Record<string, string>;
  ownedPaths: string[];
}
export interface Registry {
  entries: RegistryEntry[];
}
export function registryPath(scope: InstallScope, cwd = process.cwd(), home = homedir()) {
  return scope === "global" ? join(home, ".graphkit", "registry.json") : join(cwd, ".graphkit", "registry.json");
}
export async function readRegistryUnlocked(
  scope: InstallScope,
  cwd = process.cwd(),
  home = homedir(),
): Promise<Registry> {
  const path = registryPath(scope, cwd, home);
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return { entries: Array.isArray(raw?.entries) ? raw.entries : [] };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { entries: [] };
    throw new GraphKitError("SCHEMA_VIOLATION", "invalid template registry", false, error);
  }
}
export const readRegistry = readRegistryUnlocked;
export async function updateRegistryUnlocked(
  scope: InstallScope,
  mutate: (r: Registry) => Registry,
  cwd = process.cwd(),
  home = homedir(),
) {
  const path = registryPath(scope, cwd, home);
  await mkdir(dirname(path), { recursive: true });
  const next = mutate(await readRegistryUnlocked(scope, cwd, home));
  await writeJsonAtomic(path, next);
  return next;
}
export async function updateRegistry(
  scope: InstallScope,
  mutate: (r: Registry) => Registry,
  cwd = process.cwd(),
  home = homedir(),
) {
  const dir = dirname(registryPath(scope, cwd, home));
  await mkdir(dir, { recursive: true });
  return withDirectoryLock(dir, () => updateRegistryUnlocked(scope, mutate, cwd, home));
}
export async function allRegistryEntries(cwd = process.cwd(), home = homedir()) {
  const [project, global] = await Promise.all([
    readRegistryUnlocked("project", cwd, home),
    readRegistryUnlocked("global", cwd, home),
  ]);
  return [...project.entries, ...global.entries];
}
