// Shared filesystem primitives. F6 contract: any in-place rewrite of a file the
// user or a concurrent gk process may read goes through atomicWrite — a crash
// mid-write must leave the previous bytes intact, never a torn file.
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { GraphKitError } from "./errors.js";

// ponytail: DI seam — lets tests simulate a rename failure without touching the
// real filesystem. Restore via _resetRenameSeam.
let wRename: typeof renameSync = renameSync;
/** @internal test seam — inject rename implementation. */
export function _setRenameSeam(opts: { rename?: typeof renameSync }) {
  if (opts.rename) wRename = opts.rename;
}
/** @internal test seam — restore real rename. */
export function _resetRenameSeam() {
  wRename = renameSync;
}

/** Atomic write: sibling temp file + rename; cleanup temp on rename failure. */
export function atomicWrite(filePath: string, data: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  try {
    wRename(tmp, filePath);
  } catch (e) {
    try {
      // cleanup on failure; ignore errors — temp file may have been created elsewhere
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw new GraphKitError("WRITE_FAILED", `Failed to write ${filePath}: ${String(e)}`);
  }
}
