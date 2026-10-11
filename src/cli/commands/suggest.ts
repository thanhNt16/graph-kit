// src/cli/commands/suggest.ts
import { join } from "node:path";
import type { CAC } from "cac";
import { recordRequest } from "../../memory/lifecycle-store.js";
import { dismissSuggestion, rankSuggestions, readSuggestions } from "../../memory/suggest.js";
import { emit, fail, ok } from "../output.js";

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
          emit(ok({ dismissed: String(opts.dismiss) }));
        } else {
          emit(fail("SUGGESTION_NOT_FOUND", `No suggestion with id "${opts.dismiss}"`));
        }
        return;
      }
      // A suggest listing is a recall invocation — one offer opportunity in
      // the adherence lifecycle denominator.
      recordRequest(memDir);
      let ranked = rankSuggestions(readSuggestions(memDir));
      if (!opts.all) ranked = ranked.filter((s) => s.status === "proposed");
      emit(ok({ count: ranked.length, suggestions: ranked }));
    });
}
