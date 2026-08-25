import type { CAC } from "cac";
import { fail } from "../output.js";

export function registerVisualizeCommand(cli: CAC) {
  cli
    .command("visualize [file]", "Visualize a graph.yaml (not yet implemented)")
    .option("--json", "JSON output")
    .action(() => {
      console.log(
        JSON.stringify(
          fail("NOT_IMPLEMENTED", "gk visualize is not implemented yet. Use `gk graph ascii` or `gk graph svg`."),
        ),
      );
      process.exit(1);
    });
}