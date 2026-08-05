import { mkdir } from "node:fs/promises";
import lockfile from "proper-lockfile";

/** Run `fn` while holding an exclusive lock on `dir`; release on exit. */
export async function withDirectoryLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  // Ensure the lock target exists so a missing parent dir cannot make
  // proper-lockfile treat ENOENT as transient and retry 20x (a hang).
  await mkdir(dir, { recursive: true });
  const release = await lockfile.lock(dir, { realpath: false, retries: { retries: 20 } });
  try {
    return await fn();
  } finally {
    await release();
  }
}
