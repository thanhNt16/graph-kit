import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { fail, ok } from "../output.js";

// The kit source ships inside the npm package: <package-root>/claude/
// Resolve relative to this module, not process.cwd().
function kitSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "claude"),
    join(here, "..", "..", "..", "claude"),
    join(here, "..", "..", "..", "..", "claude"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new GraphKitError("KIT_SOURCE_MISSING", "Bundled claude/ directory not found");
  return found;
}

// Re-exported so graph.ts can resolve the templates dir the same way.
export function templatesDir(): string {
  return join(kitSourceDir(), "templates");
}

export function installKit(targetDir: string): { installed: string[] } {
  const source = kitSourceDir();
  const claudeDir = join(targetDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  // cpSync with recursive handles the whole tree; force: false → never clobber user edits
  cpSync(source, claudeDir, { recursive: true, force: false });

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
    .action(() => {
      try {
        const result = installKit(process.cwd());
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
