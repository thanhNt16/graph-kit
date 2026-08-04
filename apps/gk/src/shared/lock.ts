import lockfile from "proper-lockfile";

/** Run `fn` while holding an exclusive lock on `dir`; release on exit. */
export async function withDirectoryLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(dir, { realpath: false, retries: { retries: 20 } });
  try {
    return await fn();
  } finally {
    await release();
  }
}
