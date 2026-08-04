import { link, mkdtemp, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { GraphKitError } from "../errors.js";
import { withDirectoryLock } from "./lock.js";

/** Collision-safe sibling temp dir for `path`; caller writes a `data` file inside. */
async function tempDirFor(path: string): Promise<string> {
  return mkdtemp(join(dirname(path), `.${basename(path)}.tmp-${process.pid}-`));
}

/**
 * Publish `source` to `target` without ever replacing an existing file.
 * Hard link is atomic and fails with EEXIST if `target` exists; the temp
 * source is then unlinked. Exactly one concurrent writer succeeds.
 */
async function publishCreateOnly(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch (err) {
    await unlink(source).catch(() => {});
    if ((err as { code?: string }).code === "EEXIST") {
      throw new GraphKitError("MODIFIED_TARGET", `Refusing to overwrite immutable file: ${target}`);
    }
    throw err;
  }
  await unlink(source).catch(() => {});
}

/** Atomic write of raw `content`: sibling temp file + fsync + rename (or create-only publish). */
async function writeFileAtomic(path: string, content: string, immutable: boolean): Promise<void> {
  const tempDir = await tempDirFor(path);
  const tmp = join(tempDir, "data");
  try {
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (immutable) {
      await publishCreateOnly(tmp, path);
    } else {
      await rename(tmp, path);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Write `value` as JSON to `path` atomically. If `immutable`, never overwrites. */
export async function writeJsonAtomic(path: string, value: unknown, immutable = false): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2), immutable);
}

/** Write raw text to `path` atomically. If `immutable`, never overwrites. */
export async function writeTextAtomic(path: string, content: string, immutable = false): Promise<void> {
  await writeFileAtomic(path, content, immutable);
}

/**
 * Append `event` as a whole JSON line to `path`, crash-safe: read existing
 * content, append exactly one line in memory, then atomic temp+rename. Never
 * leaves a truncated line or a temp file behind.
 */
export async function appendEvent(path: string, event: unknown): Promise<void> {
  await withDirectoryLock(dirname(path), () => appendEventUnlocked(path, event));
}

/** Append while the caller already holds the directory lock. */
async function appendEventUnlocked(path: string, event: unknown): Promise<void> {
  const existing = await readFile(path, "utf8").catch((err) => {
    if ((err as { code?: string }).code === "ENOENT") return "";
    throw err;
  });
  await writeFileAtomic(path, `${existing}${JSON.stringify(event)}\n`, false);
}
