import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { fail, ok } from "../output.js";

// The kit source ships inside the npm package: <package-root>/claude/
// Resolve relative to this module, not process.cwd().
function kitSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  // 1. Explicit env override
  if (process.env.GK_KIT_DIR && existsSync(process.env.GK_KIT_DIR)) return process.env.GK_KIT_DIR;

  const candidates = [
    // 2. Dev: src/cli/commands/ → apps/gk/claude/
    join(here, "..", "..", "claude"),
    join(here, "..", "..", "..", "claude"),
    join(here, "..", "..", "..", "..", "claude"),
    // 3. npm package: dist/index.js → package-root/claude/ (npm link, npm install -g)
    join(here, "..", "claude"),
    join(here, "claude"),
    // 4. Standalone binary layout: <bin>/../share/gk/claude/
    join(dirname(process.execPath), "..", "share", "gk", "claude"),
    // 5. User home install: ~/.graphkit/claude/
    join(process.env.HOME ?? "", ".graphkit", "claude"),
    // 6. cwd fallbacks (works from repo root)
    join(process.cwd(), "claude"),
    join(process.cwd(), "apps", "gk", "claude"),
  ];

  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new GraphKitError("KIT_SOURCE_MISSING", "Bundled claude/ directory not found", {
      hint: "Set GK_KIT_DIR to the claude/ directory, or install the kit: sudo cp -r claude /usr/local/share/gk/claude",
      tried: candidates,
    });
  }
  return found;
}

// Re-exported so graph.ts can resolve the templates dir the same way.
export function templatesDir(): string {
  return join(kitSourceDir(), "templates");
}

export function installKit(targetDir: string, fresh = false): { installed: string[] } {
  const source = kitSourceDir();
  const claudeDir = join(targetDir, ".claude");

  // --force / fresh: wipe old .claude/ and reinstall clean
  if (fresh && existsSync(claudeDir)) {
    rmSync(claudeDir, { recursive: true, force: true });
  }

  mkdirSync(claudeDir, { recursive: true });
  // fresh → force:true (overwrite everything); else force:false (preserve user edits)
  cpSync(source, claudeDir, { recursive: true, force: fresh });

  // settings.json is kit-owned infrastructure (hook config), always overwrite
  const settingsSrc = join(source, "settings.json");
  if (existsSync(settingsSrc)) {
    cpSync(settingsSrc, join(claudeDir, "settings.json"), { force: true });
  }

  const gkConfig = join(claudeDir, ".gk.json");
  if (!existsSync(gkConfig)) {
    writeFileSync(gkConfig, JSON.stringify({ codingLevel: 0, statusline: "full" }, null, 2));
  }
  return { installed: readdirSync(claudeDir) };
}

export function registerKitCommands(cli: CAC) {
  cli
    .command("init", "Install the GraphKit kit into the current project")
    .option("--json", "JSON output")
    .option("--force", "Remove previous .claude/ and install fresh")
    .action((opts) => {
      try {
        const result = installKit(process.cwd(), opts.force);
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
    .action((opts) => {
      if (!opts.dir) {
        console.log(JSON.stringify(fail("MISSING_DIR", "--dir is required")));
        process.exit(1);
      }
      if (existsSync(opts.dir) && readdirSync(opts.dir).length > 0) {
        console.log(JSON.stringify(fail("DIR_NOT_EMPTY", `Directory ${opts.dir} exists and is not empty`)));
        process.exit(1);
      }
      mkdirSync(opts.dir, { recursive: true });
      const result = installKit(opts.dir);
      console.log(JSON.stringify(ok({ created: opts.dir, ...result })));
    });
}
