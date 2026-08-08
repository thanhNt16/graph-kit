import { cac } from "cac";
import { registerKitCommands } from "./cli/commands/kit.js";
import { registerGraphCommands } from "./cli/commands/graph.js";

const cli = cac("gk");
registerKitCommands(cli);
registerGraphCommands(cli);
cli.parse();
