#!/usr/bin/env node
// PostToolUse: index evidence writes for gk:status / gk:evidence. Fail-open.
// ponytail: Cursor payload fields assumed: tool_name, tool_input.file_path (same as Claude Code).
const fs = require("node:fs");
const path = require("node:path");

function main() {
  let input = "";
  try {
    input = fs.readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }
  try {
    const event = JSON.parse(input);
    if (event.tool_name !== "Write") process.exit(0);
    const file = event.tool_input?.file_path ?? event.tool_input?.path ?? "";
    if (!file.includes(".graphkit/evidence/")) process.exit(0);
    const indexFile = ".graphkit/evidence/.index";
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.appendFileSync(indexFile, JSON.stringify({ file, at: new Date().toISOString() }) + "\n");
  } catch {
    /* fail-open */
  }
  process.exit(0);
}
main();
