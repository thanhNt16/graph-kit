import type { CAC } from "cac";
import { fail } from "../output.js";

export function registerExecuteCommand(cli: CAC) {
  cli
    .command("execute [file]", "Execute a graph.yaml (not yet implemented)")
    .option("--json", "JSON output")
    .option("--worktree", "Isolate write nodes in git worktrees")
    .action(() => {
      console.log(
        JSON.stringify(
          fail("NOT_IMPLEMENTED", "gk execute is not implemented yet. Use /gk:execute skill or `gk compile` + run."),
        ),
      );
      process.exit(1);
    });
}
