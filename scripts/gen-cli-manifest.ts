// Regenerates cli-manifest.json from CLI_COMMANDS — the manifest is a mirror, this is its source of truth.
// Run after changing src/cli/command-registry.ts. File is biome-ignored (generated).
import { writeFileSync } from "node:fs";
import { cliManifest } from "../src/cli/command-registry.js";

writeFileSync("cli-manifest.json", `${JSON.stringify(cliManifest(), null, 2)}\n`);
