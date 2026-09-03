#!/usr/bin/env node
import { cac } from "cac";
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
registerStatusCommand(cli);
registerExecuteCommand(cli);
registerVisualizeCommand(cli);
registerRunCommands(cli);
registerSuggestCommands(cli);
cli.help();
cli.parse();

// F1: bare `gk` (or `gk --version` alone) must not be a silent exit-0 no-op.
// After parse, no matched command + no flags that cac self-printed its own
// output for (help/version) ⇒ print help and exit 1, telling the user to
// pick a command; "no command" is a usage error, not success.
const consumed = cli.options.help || cli.options.version;
if (!cli.matchedCommand && !consumed) {
  cli.outputHelp();
  process.exitCode = 1;
}
