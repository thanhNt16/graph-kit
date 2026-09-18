// Builds the fully-registered cac instance — the composition root shared by
// src/index.ts (bin entry), gen-cli-manifest.ts, and check-cli-parity.ts, so
// every consumer sees the identical command surface.
import { type CAC, cac } from "cac";
import { APP_VERSION } from "../version.js";
import { registerEvidenceCommand } from "./commands/evidence.js";
import { registerGateCommand } from "./commands/gate.js";
import { registerGraphCommands } from "./commands/graph.js";
import { registerInventoryCommands } from "./commands/inventory.js";
import { registerKitCommands } from "./commands/kit.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerModelsCommands } from "./commands/models.js";
import { registerRunCommands } from "./commands/run.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSuggestCommands } from "./commands/suggest.js";
import { registerTemplateCommands } from "./commands/template.js";

export function buildCli(): CAC {
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
  registerRunCommands(cli);
  registerSuggestCommands(cli);
  return cli;
}
