import type { CAC } from "cac";
import { printFail } from "../output.js";

export function registerExecuteCommand(cli: CAC) {
  cli
    .command("execute [file]", "Execute a graph.yaml (not yet implemented)")
    .option("--json", "JSON output")
    .option("--worktree", "Isolate write nodes in git worktrees")
    .action((_file, opts) => {
      printFail("NOT_IMPLEMENTED", "gk execute is not implemented yet. Use /gk:execute skill or `gk compile` + run.", {
        json: opts.json === true,
      });
    });
}
