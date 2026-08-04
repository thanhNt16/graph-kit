import * as cacModule from "cac";

const cac = ((cacModule as { default?: unknown }).default ?? cacModule) as (
  name?: string,
) => ReturnType<typeof cacModule.cac>;

const VERSION = "0.1.0";

/**
 * Builds the cac CLI. Later tasks register workflow/template commands here.
 * Task 1 ships only global `--json` and `--version`. Zero-argument callable;
 * version is a fixed constant, not caller-supplied.
 */
export function createCli() {
  const cli = cac("gk");
  cli.option("--json", "emit the machine result envelope", { default: false });
  cli.version(VERSION);
  cli.help();
  return { cli };
}

export type Cli = ReturnType<typeof createCli>;
