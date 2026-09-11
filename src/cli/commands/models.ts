import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import { atomicWrite } from "../../fs.js";
import type { Tier } from "../../targets/index.js";
import { isValidTarget, listTargets, resolveModel } from "../../targets/index.js";
import { subcommandHelpFor } from "../command-registry.js";
import { fail, ok } from "../output.js";

function overridesPath(cwd: string, target: string): string {
  return join(cwd, ".graphkit", `models.${target}.json`);
}

export interface OverridesRead {
  overrides: Record<string, string>;
  /** the file exists but is not parseable JSON — set must not silently clobber it */
  corrupt: boolean;
}

export function loadOverrides(cwd: string, target: string): OverridesRead {
  const p = overridesPath(cwd, target);
  if (!existsSync(p)) return { overrides: {}, corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return { overrides: {}, corrupt: true };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return { overrides: out, corrupt: false };
  } catch {
    // Silent {} used to let the next `set` merge into an empty object and
    // permanently erase every override the user had configured.
    return { overrides: {}, corrupt: true };
  }
}

function writeOverrides(cwd: string, target: string, overrides: Record<string, string>): void {
  const p = overridesPath(cwd, target);
  mkdirSync(dirname(p), { recursive: true });
  atomicWrite(p, `${JSON.stringify(overrides, null, 2)}\n`);
}

export function registerModelsCommands(cli: CAC): void {
  // cac (6.x) matches a single leading token only; "models cursor" never
  // dispatches. Use one `models` command with subcommand dispatch (like memory).
  cli
    .command("models [subcommand] [args...]", "Per-target model mapping commands")
    .example(subcommandHelpFor("models"))
    .option("--map <k=v,...>", "comma-separated model=override pairs")
    .option("--force", "set: overwrite an unparseable overrides file")
    .option("--json", "JSON output")
    .action(
      (
        subcommand: string | undefined,
        args: string | string[] | undefined,
        opts: { map?: string; force?: boolean; json?: boolean },
      ) => {
        if (!subcommand) {
          // Bare `gk models` prints usage and exits 0 — same surface as `gk memory`.
          console.log(
            `gk models — per-target model mapping commands\n\nUsage:\n  gk models <target> [args...]\n\nTargets: ${listTargets()
              .map((t) => t.id)
              .join(
                ", ",
              )}\n\nOptions:\n  --map <k=v,...>  comma-separated model=override pairs\n  --json           JSON output`,
          );
          return;
        }
        if (!isValidTarget(subcommand)) {
          console.log(
            JSON.stringify(
              fail("UNKNOWN_MODELS_SUBCOMMAND", `Unknown models subcommand "${subcommand}"`, {
                available: listTargets().map((t) => t.id),
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
            console.log(JSON.stringify(fail("MAP_INVALID", "Missing --map k=v pairs")));
            process.exit(1);
            return;
          }
          const { overrides, corrupt } = loadOverrides(process.cwd(), subcommand);
          if (corrupt && !opts.force) {
            console.log(
              JSON.stringify(
                fail(
                  "OVERRIDES_CORRUPT",
                  `${overridesPath(process.cwd(), subcommand)} is not valid JSON — fix or delete it (or run \`gk models ${subcommand} reset\`); pass --force to discard it`,
                  { hint: "Writing now would erase the unreadable file's contents" },
                ),
              ),
            );
            process.exit(1);
            return;
          }
          for (const pair of opts.map.split(",")) {
            const [k, ...tail] = pair.split("=");
            const v = tail.join("=");
            if (!k || !v) {
              console.log(JSON.stringify(fail("MAP_INVALID", `Invalid mapping '${pair}', expected k=v`)));
              process.exit(1);
              return;
            }
            overrides[k.trim()] = v.trim();
          }
          writeOverrides(process.cwd(), subcommand, overrides);
          console.log(JSON.stringify(ok(overrides)));
        } else if (action === "reset") {
          rmSync(overridesPath(process.cwd(), subcommand), { force: true });
          console.log(JSON.stringify(ok({ reset: true })));
        } else if (action !== "") {
          console.log(
            JSON.stringify(
              fail("UNKNOWN_MODELS_SUBCOMMAND", `Unknown models subcommand "${action}"`, {
                available: listTargets().map((t) => t.id),
              }),
            ),
          );
          process.exit(1);
        } else {
          const { overrides } = loadOverrides(process.cwd(), subcommand);
          const data: Record<string, string> = {};
          for (const tier of ["opus", "sonnet", "haiku", "fable"] as Tier[]) {
            data[tier] = resolveModel(subcommand, tier, overrides);
          }
          console.log(JSON.stringify(ok(data)));
        }
      },
    );
}
