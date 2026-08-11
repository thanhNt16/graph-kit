import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import { CURSOR_MODEL_DEFAULTS, resolveCursorModel } from "../../models/cursor-map.js";
import type { Tier } from "../../models/cursor-map.js";
import { fail, ok } from "../output.js";

function overridesPath(cwd: string): string {
  return join(cwd, ".graphkit", "models.cursor.json");
}

export function loadOverrides(cwd: string): Record<string, string> {
  const p = overridesPath(cwd);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeOverrides(cwd: string, overrides: Record<string, string>): void {
  const p = overridesPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(overrides, null, 2) + "\n");
}

export function registerModelsCommands(cli: CAC): void {
  // cac (6.x) matches a single leading token only; "models cursor" never
  // dispatches. Use one `models` command with subcommand dispatch (like memory).
  cli
    .command("models <subcommand> [args...]", "Cursor model mapping commands")
    .option("--map <k=v,...>", "comma-separated model=override pairs")
    .option("--json", "JSON output")
    .action((subcommand: string, args: string | string[] | undefined, opts: { map?: string }) => {
      if (subcommand !== "cursor") {
        console.log(
          JSON.stringify(
            fail("UNKNOWN_MODELS_SUBCOMMAND", `Unknown models subcommand "${subcommand}"`, {
              available: ["cursor"],
            }),
          ),
        );
        process.exit(1);
        return;
      }
      const rest = Array.isArray(args) ? args : args == null ? [] : [args];
      if (rest[0] === "set") {
        if (!opts.map) {
          console.log(JSON.stringify(fail("map", "Missing --map k=v pairs")));
          return;
        }
        const overrides = loadOverrides(process.cwd());
        for (const pair of opts.map.split(",")) {
          const [k, ...tail] = pair.split("=");
          const v = tail.join("=");
          if (!k || !v) {
            console.log(JSON.stringify(fail("map", `Invalid mapping '${pair}', expected k=v`)));
            return;
          }
          overrides[k.trim()] = v.trim();
        }
        writeOverrides(process.cwd(), overrides);
        console.log(JSON.stringify(ok(overrides)));
      } else if (rest[0] === "reset") {
        rmSync(overridesPath(process.cwd()), { force: true });
        console.log(JSON.stringify(ok({ reset: true })));
      } else {
        const overrides = loadOverrides(process.cwd());
        const data: Record<string, string> = {};
        for (const tier of Object.keys(CURSOR_MODEL_DEFAULTS) as Tier[]) {
          data[tier] = resolveCursorModel(tier, overrides);
        }
        data["_override_file"] = existsSync(overridesPath(process.cwd())) ? overridesPath(process.cwd()) : "";
        console.log(JSON.stringify(ok(data)));
      }
    });
}
