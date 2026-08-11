#!/usr/bin/env bash
# Build the viewer: bundle the launcher + server.mjs into claude/viewer and
# cursor/viewer, and bundle app.ts -> app.js. Run from apps/gk.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[viewer] bundling launcher/server.mjs…"
bun build scripts/viewer-launch.ts --target=bun --outfile=claude/viewer/server.mjs
cp claude/viewer/server.mjs cursor/viewer/server.mjs

echo "[viewer] bundling app.ts -> app.js…"
bun build src/viewer/app.ts --target=browser --format=iife --outfile=claude/viewer/app.js
cp claude/viewer/app.js cursor/viewer/app.js

bun build scripts/dagre-entry.ts --target=browser --format=iife --global-name=dagre --outfile=claude/viewer/dagre.js
cp claude/viewer/dagre.js cursor/viewer/dagre.js

# styles.css is shared source, not bundled — mirror it so claude/cursor stay
# byte-identical (viewer-parity.test.ts enforces this).
cp claude/viewer/styles.css cursor/viewer/styles.css

echo "[viewer] done"