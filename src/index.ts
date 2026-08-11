#!/usr/bin/env node
import { cac } from "cac";
import { registerGraphCommands } from "./cli/commands/graph.js";
import { registerInventoryCommands } from "./cli/commands/inventory.js";
import { registerKitCommands } from "./cli/commands/kit.js";
import { registerMemoryCommands } from "./cli/commands/memory.js";
import { registerModelsCommands } from "./cli/commands/models.js";
import { registerTemplateCommands } from "./cli/commands/template.js";
import { APP_VERSION } from "./version.js";

const cli = cac("gk").version(APP_VERSION);
registerKitCommands(cli);
registerGraphCommands(cli);
registerMemoryCommands(cli);
registerModelsCommands(cli);
registerTemplateCommands(cli);
registerInventoryCommands(cli);
cli.help();
cli.parse();
