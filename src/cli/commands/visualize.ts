import type { CAC } from "cac";
import { printFail } from "../output.js";

export function registerVisualizeCommand(cli: CAC) {
  cli
    .command("visualize [file]", "Visualize a graph.yaml (not yet implemented)")
    .option("--json", "JSON output")
    .action((_file, opts) => {
      printFail("NOT_IMPLEMENTED", "gk visualize is not implemented yet. Use `gk graph ascii` or `gk graph svg`.", {
        json: opts.json === true,
      });
    });
}
