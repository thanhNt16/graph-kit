import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { GraphKitError } from "../errors.js";

function unsafePath(message: string): GraphKitError {
  return new GraphKitError("UNSAFE_PATH", message);
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]/).some((segment) => segment === "..");
}

/** Decode until stable; each successful encoded-octet pass strictly shortens input. */
function decodeAll(input: string): string {
  let value = input;
  for (;;) {
    if (hasTraversal(value)) throw unsafePath(`Traversal rejected: ${input}`);
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      throw unsafePath(`Malformed encoded path: ${input}`);
    }
    if (decoded === value) return value;
    value = decoded;
  }
}

/** Realpath deepest existing ancestor, preserving a missing suffix. */
async function realpathOfExisting(path: string): Promise<string> {
  let current = path;
  const missing: string[] = [];
  for (;;) {
    try {
      const resolved = await realpath(current);
      return missing.length ? join(resolved, ...missing) : resolved;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw unsafePath(`No real path exists for ${path}`);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** Resolve a relative path inside base, rejecting traversal, rooted paths, and escaping symlinks. */
export async function safeResolve(base: string, relativePath: string): Promise<string> {
  const decoded = decodeAll(relativePath);
  if (isAbsolute(decoded) || /^([A-Za-z]:[\\/]|\\\\|\\)/.test(decoded) || hasTraversal(decoded)) {
    throw unsafePath(`Unsafe path rejected: ${relativePath}`);
  }
  const realBase = await realpathOfExisting(base);
  const target = resolve(realBase, ...decoded.split(/[\\/]/).filter((s) => s !== "" && s !== "."));
  const resolved = await realpathOfExisting(target);
  const rel = relative(realBase, resolved);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return resolved;
  throw unsafePath(`Path escapes base: ${relativePath}`);
}
