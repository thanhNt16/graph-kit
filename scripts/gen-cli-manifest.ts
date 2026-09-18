// Regenerates cli-manifest.json from the derived CLI surface (buildCli() →
// cliManifest()) — the manifest is a mirror, registration is the source of
// truth. Run after changing any register*() call. File is biome-ignored.
import { writeFileSync } from "node:fs";
import { buildCli } from "../src/cli/app.js";
import { cliManifest } from "../src/cli/command-registry.js";

writeFileSync("cli-manifest.json", `${JSON.stringify(cliManifest(buildCli()), null, 2)}\n`);
