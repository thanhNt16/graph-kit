import * as cacModule from "cac";

const cac = ((cacModule as { default?: unknown }).default ?? cacModule) as (
  name?: string,
) => ReturnType<typeof cacModule.cac>;

/**
 * Builds the cac CLI. Later tasks register workflow/template commands here.
 * Task 1 ships only global `--json` and `--version`.
 */
export function createCli(version: string) {
  const cli = cac("gk");
  cli.option("--json", "emit the machine result envelope", { default: false });
  cli.version(version);
  cli.help();
  return { cli };
}

export type Cli = ReturnType<typeof createCli>;
