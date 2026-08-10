#!/usr/bin/env node
// SubagentStart: inject node constraints into worker context. Fail-open.
// ponytail: Cursor subagentStart additionalContext injection support is uncertain.
//           If Cursor doesn't surface it, encode constraints in agent body / a rules file instead.
const fs = require("node:fs");

function main() {
  let input = "";
  try {
    input = fs.readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }
  try {
    const runFile = ".graphkit/runs/current.json";
    if (!fs.existsSync(runFile)) process.exit(0);
    const run = JSON.parse(fs.readFileSync(runFile, "utf-8"));
    if (!run.constraints || Object.keys(run.constraints).length === 0) process.exit(0);
    console.log(
      JSON.stringify({
        additionalContext:
          "GraphKit constraints for this node: " +
          JSON.stringify(run.constraints) +
          ". Respect assigned_only (touch only assigned files) and no_write (read-only) if present.",
      }),
    );
  } catch {
    /* fail-open */
  }
  process.exit(0);
}
main();
