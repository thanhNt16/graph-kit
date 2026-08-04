import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { sep } from "node:path";
import { GraphKitError } from "../errors.js";
import { safeResolve } from "../shared/paths.js";

export interface OwnedFile {
  path: string;
  checksum: string;
}
export interface TemplatePackageManifest {
  name: string;
  version: string;
  sourceChecksum: string;
  files: OwnedFile[];
}
export const checksum = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export async function checksumFile(path: string) {
  return checksum(await readFile(path));
}
export async function collectTemplateFiles(directory: string): Promise<OwnedFile[]> {
  const paths: string[] = [];
  async function walk(dir: string): Promise<void> {
    const absolute = await safeResolve(directory, dir || ".");
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new GraphKitError("UNSAFE_PATH", `symlink rejected: ${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) paths.push(child.replaceAll(sep, "/"));
    }
  }
  await walk("");
  return Promise.all(
    paths.sort().map(async (path) => ({ path, checksum: await checksumFile(await safeResolve(directory, path)) })),
  );
}
export async function templateChecksum(directory: string) {
  const files = await collectTemplateFiles(directory);
  return checksum(files.map((file) => `${file.path}\0${file.checksum}`).join("\n"));
}
