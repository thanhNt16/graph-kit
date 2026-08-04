import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { GraphKitError } from "../errors.js";

function unsafePath(message: string): GraphKitError {
  return new GraphKitError("UNSAFE_PATH", message);
}

/** Decode repeatedly so double-encoded traversal (%252e) cannot hide `..`. */
function decodeAll(input: string): string {
  let value = input;
  for (let i = 0; i < 10; i++) {
    const decoded = decodeURIComponent(value);
    if (decoded === value) return value;
    value = decoded;
  }
  return value;
}

/** Realpath of the deepest existing ancestor of `path` plus any missing suffix. */
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

/**
 * Resolve `relative` under `base`, rejecting `..`, absolute segments, and
 * symlinks that resolve outside `base`. The returned path is always inside the
 * real `base` directory.
 */
export async function safeResolve(base: string, relativePath: string): Promise<string> {
  const decoded = decodeAll(relativePath);
  if (isAbsolute(decoded)) throw unsafePath(`Absolute path rejected: ${relative}`);
  const segments = decoded.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) throw unsafePath(`Traversal rejected: ${relative}`);

  const realBase = await realpathOfExisting(base);
  const target = resolve(realBase, ...segments);
  const resolved = await realpathOfExisting(target);

  const rel = relative(realBase, resolved);
  if (rel === "") return realBase;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw unsafePath(`Path escapes base: ${relative}`);
  }
  return resolved;
}
