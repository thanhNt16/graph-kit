// Kit source resolution — WHERE the bundled kits/ tree lives for this install
// shape. Moved out of cli/commands/kit.ts (round 5): it is install-layout
// logic, not a command, and both the kit installer and the graph compiler's
// templatesDir need it without a cli→cli cross-import.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphKitError } from "../errors.js";
import { getTarget } from "./registry.js";
import type { TargetId } from "./types.js";

export function kitSourceDir(targetId: TargetId = "claude"): string {
  const t = getTarget(targetId);
  const here = dirname(fileURLToPath(import.meta.url));
  const kitName = t.kitDirName;

  // 1. Explicit env override
  if (process.env.GK_KIT_DIR && existsSync(process.env.GK_KIT_DIR)) return process.env.GK_KIT_DIR;

  const candidates = [
    // 2. Dev: src/targets/ → kits/<kit>/
    join(here, "..", "..", "..", "kits", kitName),
    join(here, "..", "..", "kits", kitName),
    // 3. npm package: dist/index.js → package-root/kits/<kit>/ (npm link, npm install -g)
    join(here, "..", "kits", kitName),
    join(here, "kits", kitName),
    // 4. Standalone binary layout: <bin>/share/gk/kits/<kit>/ (extracted
    // side-by-side with the binary — wins over #5 because it can only come
    // from the same tarball as this binary, while ../share may be a stale
    // kit left by an earlier install under a different prefix)
    join(dirname(process.execPath), "share", "gk", "kits", kitName),
    // 5. Standalone binary layout: <bin>/../share/gk/kits/<kit>/
    join(dirname(process.execPath), "..", "share", "gk", "kits", kitName),
    // 6. User home install: ~/.graphkit/kits/<kit>/
    join(process.env.HOME ?? "", ".graphkit", "kits", kitName),
    // 7. cwd fallbacks (works from repo root)
    join(process.cwd(), "kits", kitName),
    join(process.cwd(), "apps", "gk", "kits", kitName),
  ];

  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new GraphKitError("KIT_SOURCE_MISSING", `Bundled kits/${kitName}/ directory not found`, {
      hint: `Set GK_KIT_DIR to the kits/${kitName}/ directory, or install the kit: sudo cp -r kits/${kitName} /usr/local/share/gk/kits/${kitName}`,
      tried: candidates,
    });
  }
  return found;
}

/** The graph templates dir bundled beside the kit source. */
export function templatesDir(target: TargetId = "claude"): string {
  return join(kitSourceDir(target), "templates");
}
