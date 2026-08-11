import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import type { Tier } from "../../models/cursor-map.js";
import { CURSOR_MODEL_DEFAULTS, resolveCursorModel } from "../../models/cursor-map.js";
import { fail, ok } from "../output.js";

function overridesPath(cwd: string): string {
  return join(cwd, ".graphkit", "models.cursor.json");
}

export function loadOverrides(cwd: string): Record<string, string> {
  const p = overridesPath(cwd);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeOverrides(cwd: string, overrides: Record<string, string>): void {
  const p = overridesPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(overrides, null, 2)}\n`);
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
      const action = rest[0] ?? "";
      if (action === "set") {
        if (!opts.map) {
          console.log(JSON.stringify(fail("map", "Missing --map k=v pairs")));
          process.exit(1);
          return;
        }
        const overrides = loadOverrides(process.cwd());
        for (const pair of opts.map.split(",")) {
          const [k, ...tail] = pair.split("=");
          const v = tail.join("=");
          if (!k || !v) {
            console.log(JSON.stringify(fail("map", `Invalid mapping '${pair}', expected k=v`)));
            process.exit(1);
            return;
          }
          overrides[k.trim()] = v.trim();
        }
        writeOverrides(process.cwd(), overrides);
        console.log(JSON.stringify(ok(overrides)));
      } else if (action === "reset") {
        rmSync(overridesPath(process.cwd()), { force: true });
        console.log(JSON.stringify(ok({ reset: true })));
      } else if (action !== "") {
        console.log(
          JSON.stringify(
            fail("UNKNOWN_MODELS_SUBCOMMAND", `Unknown models subcommand "${action}"`, {
              available: ["cursor"],
            }),
          ),
        );
        process.exit(1);
      } else {
        const overrides = loadOverrides(process.cwd());
        const data: Record<string, string> = {};
        for (const tier of Object.keys(CURSOR_MODEL_DEFAULTS) as Tier[]) {
          data[tier] = resolveCursorModel(tier, overrides);
        }
        console.log(JSON.stringify(ok(data)));
      }
    });
}
