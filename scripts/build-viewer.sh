#!/usr/bin/env bash
# Build the viewer: bundle the launcher + server.mjs into kits/claude/viewer and
# kits/cursor/viewer, and bundle app.ts -> app.js. Run from apps/gk.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[viewer] bundling launcher/server.mjs…"
bun build scripts/viewer-launch.ts --target=bun --outfile=kits/claude/viewer/server.mjs
cp kits/claude/viewer/server.mjs kits/cursor/viewer/server.mjs

echo "[viewer] bundling app.ts -> app.js…"
bun build src/viewer/app.ts --target=browser --format=iife --outfile=kits/claude/viewer/app.js
cp kits/claude/viewer/app.js kits/cursor/viewer/app.js

bun build scripts/dagre-entry.ts --target=browser --format=iife --global-name=dagre --outfile=kits/claude/viewer/dagre.js
cp kits/claude/viewer/dagre.js kits/cursor/viewer/dagre.js

# styles.css is shared source, not bundled — mirror it so claude/cursor stay
# byte-identical (viewer-parity.test.ts enforces this).
cp kits/claude/viewer/styles.css kits/cursor/viewer/styles.css

echo "[viewer] done"