import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Fingerprint {
  head: string | null;
  tree: string | null;
}

function git(args: string[], cwd: string): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim();
}

/** Files > 1 MiB contribute size+mtime, not content — cheap on big binaries. */
const HASH_CAP_BYTES = 1024 * 1024;

/**
 * Repo fingerprint: `head` = current commit; `tree` = sha256 over sorted
 * `"<relpath>:<contenthash>"` lines for dirty tracked + untracked non-ignored files.
 * Non-git (or git failure) → `{ head: null, tree: null }`. Never throws.
 */
export function fingerprint(cwd: string): Fingerprint {
  const head = git(["rev-parse", "HEAD"], cwd);
  if (head === null) return { head: null, tree: null };
  const changed = git(["ls-files", "-m"], cwd)?.split("\n").filter(Boolean) ?? [];
  const untracked = git(["ls-files", "-o", "--exclude-standard"], cwd)?.split("\n").filter(Boolean) ?? [];
  const lines: string[] = [];
  // .graphkit/ holds kit outputs (runs, evidence) — state noise, never source;
  // excluded so writing a marker never invalidates the fingerprint it records.
  for (const rel of [...new Set([...changed, ...untracked])].filter((r) => !r.startsWith(".graphkit/")).sort()) {
    const p = join(cwd, rel);
    try {
      const st = statSync(p);
      const h =
        st.size > HASH_CAP_BYTES
          ? `size:${st.size}:mtime:${Math.floor(st.mtimeMs)}`
          : createHash("sha256").update(readFileSync(p)).digest("hex");
      lines.push(`${rel}:${h}`);
    } catch {
      // file vanished between listing and hashing — skip, never throw
    }
  }
  return { head, tree: createHash("sha256").update(lines.join("\n")).digest("hex") };
}
