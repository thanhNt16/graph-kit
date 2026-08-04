import { cp, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { InstallOptions } from "./installer-internal.js";
import { createInstaller } from "./installer-internal.js";
import { updateRegistryUnlocked } from "./registry.js";

export type { InstallOptions, InstallResult } from "./installer-internal.js";

const installer = createInstaller({ mkdir, cp, rm, writeFile, lstat, updateRegistry: updateRegistryUnlocked });

export async function installTemplate(source: string, options: InstallOptions = {}) {
  return installer.installTemplate(source, { home: process.env.HOME ?? homedir(), ...options });
}
export async function removeOwnedPaths(
  ownedPaths: string[],
  scope: import("./registry.js").InstallScope,
  cwd: string,
  home: string,
  name = "",
  version = "",
) {
  return installer.removeOwnedPaths(ownedPaths, scope, cwd, home, name, version);
}
export async function validateOwnedPath(
  path: string,
  scope: import("./registry.js").InstallScope,
  cwd: string,
  home: string,
  name: string,
  version: string,
) {
  return installer.validateOwnedPath(path, scope, cwd, home, name, version);
}
