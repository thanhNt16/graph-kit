#!/usr/bin/env node
import { buildCli } from "./cli/app.js";

const cli = buildCli();
cli.help();
cli.parse();

// F1: bare `gk` (or `gk --version` alone) must not be a silent exit-0 no-op.
// After parse, no matched command + no flags that cac self-printed its own
// output for (help/version) => print help and exit 1, telling the user to
// pick a command; "no command" is a usage error, not success.
const consumed = cli.options.help || cli.options.version;
if (!cli.matchedCommand && !consumed) {
  cli.outputHelp();
  process.exitCode = 1;
}
