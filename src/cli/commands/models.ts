import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import { isValidTarget, listTargets, resolveModel, TIERS } from "../../targets/index.js";
import { leafUsageFor } from "../command-registry.js";
import { emit, fail, ok } from "../output.js";

function overridesPath(cwd: string, target: string): string {
  return join(cwd, ".graphkit", `models.${target}.json`);
}

export function loadOverrides(cwd: string, target: string): Record<string, string> {
  const p = overridesPath(cwd, target);
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

function writeOverrides(cwd: string, target: string, overrides: Record<string, string>): void {
  const p = overridesPath(cwd, target);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(overrides, null, 2)}\n`);
}

export function registerModelsCommands(cli: CAC): void {
  // cac (6.x) matches a single leading token only; "models cursor" never
  // dispatches. Use one `models` command with subcommand dispatch (like memory).
  cli
    .command("models [subcommand] [args...]", "Per-target model mapping commands")
    .option("--map <k=v,...>", "comma-separated model=override pairs")
    .option("--json", "JSON output")
    .example(leafUsageFor("models"))
    .action((subcommand: string | undefined, args: string | string[] | undefined, opts: { map?: string }) => {
      if (!subcommand) {
        // Bare `gk models` prints usage and exits 0 — same surface as `gk memory`.
        console.log(
          `gk models — per-target model mapping commands\n\nUsage:\n  gk models <target> [args...]\n\nTargets:\n${leafUsageFor("models")}\n\nOptions:\n  --map <k=v,...>  comma-separated model=override pairs\n  --json           JSON output`,
        );
        return;
      }
      if (!isValidTarget(subcommand)) {
        emit(
          fail("UNKNOWN_MODELS_SUBCOMMAND", `Unknown models subcommand "${subcommand}"`, {
            available: listTargets().map((t) => t.id),
          }),
        );
        return;
      }
      const rest = Array.isArray(args) ? args : args == null ? [] : [args];
      const action = rest[0] ?? "";
      if (action === "set") {
        if (!opts.map) {
          emit(fail("map", "Missing --map k=v pairs"));
          return;
        }
        const overrides = loadOverrides(process.cwd(), subcommand);
        for (const pair of opts.map.split(",")) {
          const [k, ...tail] = pair.split("=");
          const v = tail.join("=");
          if (!k || !v) {
            emit(fail("map", `Invalid mapping '${pair}', expected k=v`));
            return;
          }
          overrides[k.trim()] = v.trim();
        }
        writeOverrides(process.cwd(), subcommand, overrides);
        emit(ok(overrides));
      } else if (action === "reset") {
        rmSync(overridesPath(process.cwd(), subcommand), { force: true });
        emit(ok({ reset: true }));
      } else if (action !== "") {
        emit(
          fail("UNKNOWN_MODELS_SUBCOMMAND", `Unknown models subcommand "${action}"`, {
            available: listTargets().map((t) => t.id),
          }),
        );
      } else {
        const overrides = loadOverrides(process.cwd(), subcommand);
        const data: Record<string, string> = {};
        for (const tier of TIERS) {
          data[tier] = resolveModel(subcommand, tier, overrides);
        }
        emit(ok(data));
      }
    });
}
