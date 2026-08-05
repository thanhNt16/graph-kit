import { createCli, toGraphKitError } from "./cli/command-registry.js";
import { fail } from "./cli/output.js";

async function main() {
  const cli = createCli();
  try {
    cli.cli.parse(process.argv, { run: true });
  } catch (err) {
    const error = toGraphKitError(err);
    console.log(JSON.stringify(fail(error.code, error.message, error.recoverable, error.details)));
    process.exitCode = 1;
  }
}

void main();

process.on("uncaughtException", (err) => {
  console.log(JSON.stringify(fail("SCHEMA_VIOLATION", err.message)));
  process.exitCode = 1;
});
process.on("unhandledRejection", (reason) => {
  console.log(JSON.stringify(fail("SCHEMA_VIOLATION", reason instanceof Error ? reason.message : String(reason))));
  process.exitCode = 1;
});
