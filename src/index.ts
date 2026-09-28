#!/usr/bin/env node
import { buildCli } from "./cli/app.js";

const cli = buildCli();
cli.help();
function main() {
  try {
    cli.parse();
  } catch (error) {
    // F1: parse errors (unknown option, missing option value) escape cli.parse
    // as CACError. Without this guard every typo'd flag on any of the 56 command
    // paths crashes with a raw stack dump. Parse happens before --json is
    // meaningful, so this is a plain stderr line + help, not a JSON envelope.
    console.error(error instanceof Error ? error.message : error);
    cli.outputHelp();
    process.exitCode = 1;
    return;
  }
  // F1: bare `gk` (or `gk --version` alone) must not be a silent exit-0 no-op.
  // After parse, no matched command + no flags that cac self-printed its own
  // output for (help/version) => print help and exit 1, telling the user to
  // pick a command; "no command" is a usage error, not success.
  const consumed = cli.options.help || cli.options.version;
  if (!cli.matchedCommand && !consumed) {
    // F5: a typo'd command must be distinguishable from bare `gk` — name the
    // mistake before the help; a bare invocation stays silent.
    if (cli.args.length > 0) {
      console.error(`Unknown command: ${cli.args[0]}`);
    }
    cli.outputHelp();
    process.exitCode = 1;
  }
}

main();
