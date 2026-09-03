// src/cli/commands/suggest.ts
import { join } from "node:path";
import type { CAC } from "cac";
import { dismissSuggestion, rankSuggestions, readSuggestions } from "../../memory/suggest.js";
import { fail, ok } from "../output.js";

export function registerSuggestCommands(cli: CAC) {
  cli
    .command("suggest", "Show ranked workflow suggestions from memory")
    .option("--dismiss <id>", "dismiss a suggestion by id")
    .option("--all", "include dismissed suggestions")
    .option("--json", "JSON output")
    .action((opts) => {
      const memDir = join(process.cwd(), ".graphkit", "memory");
      if (opts.dismiss) {
        if (dismissSuggestion(memDir, String(opts.dismiss))) {
          console.log(JSON.stringify(ok({ dismissed: String(opts.dismiss) })));
        } else {
          console.log(JSON.stringify(fail("SUGGESTION_NOT_FOUND", `No suggestion with id "${opts.dismiss}"`)));
        }
        return;
      }
      let ranked = rankSuggestions(readSuggestions(memDir));
      if (!opts.all) ranked = ranked.filter((s) => s.status === "proposed");
      if (opts.json) {
        console.log(JSON.stringify(ok({ count: ranked.length, suggestions: ranked })));
      } else if (ranked.length === 0) {
        console.log("No suggestions. Run `gk memory consolidate` after a few graph runs.");
      } else {
        for (const s of ranked) {
          console.log(`[${s.action}] ${s.id} (salience ${s.salience.toFixed(2)})\n  ${s.rationale}`);
        }
      }
    });
}
