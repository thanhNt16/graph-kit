#!/usr/bin/env node
import { cac } from "cac";
import { registerGraphCommands } from "./cli/commands/graph.js";
import { registerKitCommands } from "./cli/commands/kit.js";
import { registerMemoryCommands } from "./cli/commands/memory.js";

const cli = cac("gk");
registerKitCommands(cli);
registerGraphCommands(cli);
registerMemoryCommands(cli);
cli.help();
cli.parse();
