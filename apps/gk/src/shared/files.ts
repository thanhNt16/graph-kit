import { open, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { GraphKitError } from "../errors.js";

/** Write `value` as JSON to `path` atomically: temp file + fsync + rename. */
export async function writeJsonAtomic(path: string, value: unknown, immutable = false): Promise<void> {
  if (immutable) {
    try {
      await open(path, "r");
      throw new GraphKitError("MODIFIED_TARGET", `Refusing to overwrite immutable file: ${path}`);
    } catch (err) {
      if (err instanceof GraphKitError) throw err;
      // ENOENT — file does not exist, proceed.
    }
  }

  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

/** Append `event` as one JSON line to `path`, creating it if needed. */
export async function appendEvent(path: string, event: unknown): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`);
  } finally {
    await handle.close();
  }
}

/** Run `fn` while holding an exclusive lock on `dir`; release on exit. */
export async function withDirectoryLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(dir, { realpath: false, retries: { retries: 20 } });
  try {
    return await fn();
  } finally {
    await release();
  }
}
