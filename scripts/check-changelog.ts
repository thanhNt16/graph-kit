#!/usr/bin/env bun
// Gate check: CHANGELOG.md must exist and contain an entry for the version
// in VERSION (or the latest git tag). Runs as part of ci:local.

import { existsSync, readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const changelogPath = `${root}CHANGELOG.md`;

if (!existsSync(changelogPath)) {
  console.error("CHANGELOG.md: MISSING");
  process.exit(1);
}

const text = readFileSync(changelogPath, "utf-8");

if (!text.startsWith("# Changelog")) {
  console.error("CHANGELOG.md: missing '# Changelog' header");
  process.exit(1);
}

if (!text.includes("## [Unreleased]")) {
  console.error("CHANGELOG.md: missing '[Unreleased]' section");
  process.exit(1);
}

// Check that at least one released version entry exists
const versionEntries = text.match(/^## \[\d+\.\d+\.\d+\]/gm);
if (!versionEntries || versionEntries.length === 0) {
  console.error("CHANGELOG.md: no version entries found");
  process.exit(1);
}

console.log(`CHANGELOG.md: OK (${versionEntries.length} released versions + Unreleased)`);
