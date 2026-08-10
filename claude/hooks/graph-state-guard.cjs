#!/usr/bin/env node
// PreToolUse: block manual writes to evidence dir during an active graph run. Fail-open.
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
    const path = event.tool_input?.file_path ?? "";
    const activeMarker = ".graphkit/runs/.active";
    if (path.includes(".graphkit/evidence/") && fs.existsSync(activeMarker)) {
      console.log(
        JSON.stringify({
          decision: "block",
          reason:
            "Evidence files are workflow-owned while a graph run is active. Wait for the run to finish or stop it first.",
        }),
      );
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
}
main();
