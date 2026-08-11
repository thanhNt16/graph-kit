#!/usr/bin/env node
// PreToolUse: block manual writes to evidence dir during an active graph run. Fail-open.
// ponytail: Cursor folds Edit into Write matcher; tool_name may arrive as "Write" or "Edit".
//           Cursor payload fields assumed: tool_name, tool_input.file_path (same as Claude Code).
const fs = require("node:fs");

function main() {
  let input = "";
  try {
    input = fs.readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }
  try {
    const event = JSON.parse(input);
    const tool = event.tool_name ?? "";
    if (tool !== "Write" && tool !== "Edit") process.exit(0);
    const path = event.tool_input?.file_path ?? event.tool_input?.path ?? "";
    const activeMarker = ".graphkit/runs/.active";
    if (path.includes(".graphkit/evidence/") && fs.existsSync(activeMarker)) {
      console.log(
        JSON.stringify({
          decision: "block",
          reason:
            "Evidence files are workflow-owned while a graph run is active. Wait for the run to finish or stop it first.",
        }),
      );
      // Cursor: exit code 2 = deny
      process.exit(2);
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
}
main();
