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

const srv = await startViewerServer({ graphPath, assetDir });
console.log(`GraphKit viewer: ${srv.url}`);

// Open the default browser when possible; never fail if it cannot launch.
// If browser startup fails the printed keyed URL remains available.
const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
try {
  if (process.platform === "win32") spawn(openCmd, ["/c", "start", "", srv.url], { stdio: "ignore", detached: true });
  else spawn(openCmd, [srv.url], { stdio: "ignore", detached: true });
} catch {
  /* browser open failed — the printed URL is the fallback */
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
