#!/usr/bin/env node
import { cac } from "cac";
import { suggestCommand } from "./cli/command-registry.js";
import { registerDoctorCommand } from "./cli/commands/doctor.js";
import { registerEvidenceCommand } from "./cli/commands/evidence.js";
import { registerExecuteCommand } from "./cli/commands/execute.js";
import { registerGateCommand } from "./cli/commands/gate.js";
import { registerGraphCommands } from "./cli/commands/graph.js";
import { registerInventoryCommands } from "./cli/commands/inventory.js";
import { registerKitCommands } from "./cli/commands/kit.js";
import { registerMemoryCommands } from "./cli/commands/memory.js";
import { registerModelsCommands } from "./cli/commands/models.js";
import { registerRunCommands } from "./cli/commands/run.js";
import { registerStatusCommand } from "./cli/commands/status.js";
import { registerSuggestCommands } from "./cli/commands/suggest.js";
import { registerTemplateCommands } from "./cli/commands/template.js";
import { registerVisualizeCommand } from "./cli/commands/visualize.js";
import { APP_VERSION } from "./version.js";

const cli = cac("gk").version(APP_VERSION);
registerKitCommands(cli);
registerGateCommand(cli);
registerGraphCommands(cli);
registerMemoryCommands(cli);
registerModelsCommands(cli);
registerTemplateCommands(cli);
registerInventoryCommands(cli);
registerEvidenceCommand(cli);
registerStatusCommand(cli);
registerDoctorCommand(cli);
registerExecuteCommand(cli);
registerVisualizeCommand(cli);
registerRunCommands(cli);
registerSuggestCommands(cli);
cli.help();
try {
  cli.parse();
} catch (e) {
  // cac throws a raw CACError (with a Node stack) for a mistyped flag — the
  // worst output a first-time user can hit. One clean line instead; stdout
  // stays clean for scripts.
  const msg = String((e as Error)?.message ?? e).replace(/^CACError:\s*/i, "");
  if (/unknown option|unknown command/i.test(msg)) {
    console.error(`gk: ${msg} — run \`gk --help\` to see the command list`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}

// F1: bare `gk` (or `gk --version` alone) must not be a silent exit-0 no-op.
// After parse, no matched command + no flags that cac self-printed its own
// output for (help/version) ⇒ print help and exit 1, telling the user to
// pick a command; "no command" is a usage error, not success.
const consumed = cli.options.help || cli.options.version;
if (!cli.matchedCommand && !consumed) {
  const first = process.argv[2];
  if (first && !first.startsWith("-")) {
    // A mistyped command used to dump the full help with no hint at all —
    // say what went wrong, and offer the closest real command when one is.
    const suggestion = suggestCommand(first);
    console.error(
      `gk: unknown command "${first}"${suggestion ? ` — did you mean \`${suggestion}\`?` : ""} — run \`gk --help\` to see the command list`,
    );
  } else {
    cli.outputHelp();
  }
  process.exitCode = 1;
}
