#!/usr/bin/env node
import { cac } from "cac";
import { registerGraphCommands } from "./cli/commands/graph.js";
import { registerKitCommands } from "./cli/commands/kit.js";

const cli = cac("gk");
registerKitCommands(cli);
registerGraphCommands(cli);
cli.help();
cli.parse();
