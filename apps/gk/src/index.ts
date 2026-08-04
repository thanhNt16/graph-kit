import { createCli } from "./cli/command-registry.js";
import { fail } from "./cli/output.js";
import { GraphKitError } from "./errors.js";

const VERSION = "0.1.0";

async function main() {
  const cli = createCli(VERSION);
  try {
    cli.cli.parse(process.argv.slice(2), { run: true });
  } catch (err) {
    if (err instanceof GraphKitError) {
      const envelope = fail(err.code, err.message, err.recoverable, err.details);
      console.error(JSON.stringify(envelope));
      process.exitCode = 1;
    } else {
      const envelope = fail("SCHEMA_VIOLATION", err instanceof Error ? err.message : String(err));
      console.error(JSON.stringify(envelope));
      process.exitCode = 1;
    }
  }
}

void main();
