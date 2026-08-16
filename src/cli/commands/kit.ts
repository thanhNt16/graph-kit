import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { fail, ok } from "../output.js";

export type KitTarget = "claude" | "cursor";

// The kit source ships inside the npm package: <package-root>/<target>/
// Resolve relative to this module, not process.cwd().
function kitSourceDir(target: KitTarget = "claude"): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const kitName = target === "cursor" ? "cursor" : "claude";

  // 1. Explicit env override
  if (process.env.GK_KIT_DIR && existsSync(process.env.GK_KIT_DIR)) return process.env.GK_KIT_DIR;

  const candidates = [
    // 2. Dev: src/cli/commands/ → apps/gk/<kit>/
    join(here, "..", "..", kitName),
    join(here, "..", "..", "..", kitName),
    join(here, "..", "..", "..", "..", kitName),
    // 3. npm package: dist/index.js → package-root/<kit>/ (npm link, npm install -g)
    join(here, "..", kitName),
    join(here, kitName),
    // 4. Standalone binary layout: <bin>/../share/gk/<kit>/
    join(dirname(process.execPath), "..", "share", "gk", kitName),
    // 5. Standalone binary layout: <bin>/share/gk/<kit>/ (extracted side-by-side)
    join(dirname(process.execPath), "share", "gk", kitName),
    // 6. User home install: ~/.graphkit/<kit>/
    join(process.env.HOME ?? "", ".graphkit", kitName),
    // 7. cwd fallbacks (works from repo root)
    join(process.cwd(), kitName),
    join(process.cwd(), "apps", "gk", kitName),
  ];

  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new GraphKitError("KIT_SOURCE_MISSING", `Bundled ${kitName}/ directory not found`, {
      hint: `Set GK_KIT_DIR to the ${kitName}/ directory, or install the kit: sudo cp -r ${kitName} /usr/local/share/gk/${kitName}`,
      tried: candidates,
    });
  }
  return found;
}

// Re-exported so graph.ts can resolve the templates dir the same way.
export function templatesDir(target: KitTarget = "claude"): string {
  return join(kitSourceDir(target), "templates");
}

export function installKit(targetDir: string, fresh = false, target: KitTarget = "claude"): { installed: string[] } {
  const source = kitSourceDir(target);
  const installDir = target === "cursor" ? ".cursor" : ".claude";
  const destDir = join(targetDir, installDir);

  // --force / fresh: wipe old dir and reinstall clean
  if (fresh && existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }

  mkdirSync(destDir, { recursive: true });
  // Kit-owned files always overwrite — re-running `gk init` after upgrading the
  // gk binary must refresh stale skills in existing projects. Only .gk.json
  // (user config) is preserved below; --force is the only path that removes
  // files the kit no longer ships.
  cpSync(source, destDir, {
    recursive: true,
    force: true,
    // user config survives upgrades; created below if missing
    filter: (s) => basename(s) !== ".gk.json",
  });

  // settings.json is kit-owned infrastructure (hook config), always overwrite for claude
  // Cursor uses hooks.json shipped inside the cursor kit — no settings.json overwrite needed.
  if (target === "claude") {
    const settingsSrc = join(source, "settings.json");
    if (existsSync(settingsSrc)) {
      cpSync(settingsSrc, join(destDir, "settings.json"), { force: true });
    }
  }

  const gkConfig = join(destDir, ".gk.json");
  if (!existsSync(gkConfig)) {
    writeFileSync(gkConfig, JSON.stringify({ codingLevel: 0, statusline: "full" }, null, 2));
  }
  return { installed: readdirSync(destDir) };
}

export function registerKitCommands(cli: CAC) {
  cli
    .command("init", "Install the GraphKit kit into the current project")
    .option("--json", "JSON output")
    .option("--force", "Remove previous .claude/ and install fresh")
    .option("--target <target>", "Kit target: claude or cursor (default: claude)", { default: "claude" })
    .action((opts) => {
      if (!["claude", "cursor"].includes(opts.target)) {
        console.log(JSON.stringify(fail("BAD_TARGET", `Invalid target: ${opts.target}. Must be "claude" or "cursor"`)));
        process.exit(1);
      }
      try {
        const result = installKit(process.cwd(), opts.force, opts.target);
        console.log(JSON.stringify(ok(result)));
      } catch (e) {
        console.log(JSON.stringify(fail("INIT_FAILED", String(e))));
        process.exit(1);
      }
    });

  cli
    .command("new", "Scaffold a new project with the GraphKit kit")
    .option("--dir <dir>", "Target directory (required)")
    .option("--json", "JSON output")
    .option("--target <target>", "Kit target: claude or cursor (default: claude)", { default: "claude" })
    .action((opts) => {
      if (!opts.dir) {
        console.log(JSON.stringify(fail("MISSING_DIR", "--dir is required")));
        process.exit(1);
      }
      if (!["claude", "cursor"].includes(opts.target)) {
        console.log(JSON.stringify(fail("BAD_TARGET", `Invalid target: ${opts.target}. Must be "claude" or "cursor"`)));
        process.exit(1);
      }
      if (existsSync(opts.dir) && readdirSync(opts.dir).length > 0) {
        console.log(JSON.stringify(fail("DIR_NOT_EMPTY", `Directory ${opts.dir} exists and is not empty`)));
        process.exit(1);
      }
      mkdirSync(opts.dir, { recursive: true });
      const result = installKit(opts.dir, false, opts.target);
      console.log(JSON.stringify(ok({ created: opts.dir, ...result })));
    });
}
