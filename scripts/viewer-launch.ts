/**
 * Private viewer launcher — used by the gk-visualize skill. Not a public CLI.
 * Starts the read-only local viewer for a graph.yaml and prints the keyed URL.
 *
 * The build bundles this file into both kit asset dirs as server.mjs, so the
 * bundled script's own directory is the asset dir (claude/viewer or cursor/viewer).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startViewerServer } from "../src/viewer/server.js";

const scriptDir = resolve(import.meta.dir ?? process.cwd());
const assetDir = existsSync(join(scriptDir, "index.html")) ? scriptDir : resolve(scriptDir, "..", "claude", "viewer");
const graphPath = resolve(process.argv[2] ?? join(process.cwd(), "graph.yaml"));

const srv = await startViewerServer({
  graphPath,
  assetDir,
  // Default to the pinned 4800 when GK_VIEWER_PORT is unset; an explicit
  // 0/empty falls back to the server's ephemeral (historical) behavior.
  port: process.env.GK_VIEWER_PORT == null ? 4800 : Number(process.env.GK_VIEWER_PORT) || undefined,
});
console.log(`GraphKit viewer: ${srv.url}`);

// No auto-open: the printed keyed URL is the interface. Agents surface the
// link; humans click when they want it. Set GK_VIEWER_OPEN=1 to restore the
// old spawn-a-browser behavior; GK_VIEWER_BROWSER=chrome forces Chrome on
// macOS (`open -a "Google Chrome"`).
const wantOpen = process.env.GK_VIEWER_OPEN === "1";
const chrome = process.env.GK_VIEWER_BROWSER === "chrome";
if (wantOpen) {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = chrome ? ["-a", "Google Chrome", srv.url] : [srv.url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", srv.url];
  } else {
    cmd = "xdg-open";
    args = [srv.url];
  }
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  // Browser missing (ENOENT) is emitted async as 'error', not thrown — swallow
  // so a missing Chrome never crashes the launcher; the printed URL is the fallback.
  child.on("error", () => {});
}

// Explicit stop or parent termination. (Idle timeout in server.ts also exits.)
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void srv.close().finally(() => process.exit(0));
  });
}
process.on("disconnect", () => {
  void srv.close().finally(() => process.exit(0));
});
