#!/usr/bin/env node
// PostToolUse: distill evidence writes into OKF memory files under .graphkit/memory/.
// Recall reindexes on demand: this hook sets .graphkit/.memory-dirty; /gk:recall runs `gk memory index`. Fail-open.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function main() {
  let input = "";
  try { input = fs.readFileSync(0, "utf-8"); } catch { process.exit(0); }
  try {
    const event = JSON.parse(input);
    if (event.tool_name !== "Write") process.exit(0);
    const file = event.tool_input?.file_path ?? "";
    if (!file.includes(".graphkit/evidence/")) process.exit(0);

    const src = path.basename(file, ".md");
    const id = `${src}-${crypto.createHash("sha1").update(file).digest("hex").slice(0, 8)}`;
    const memDir = ".graphkit/memory";
    const memFile = path.join(memDir, `${id}.md`);
    fs.mkdirSync(memDir, { recursive: true });

    const body = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    const now = new Date().toISOString(); // UTC ISO-8601 with offset
    const frontmatter = [
      "---",
      `id: ${id}`,
      "type: knowledge",
      `source: ${file}`,
      `created_at: ${now}`,
      `valid_from: ${now}`,
      "valid_to:",
      "salience: 0.5",
      "expired: false",
      "tags: []",
      "---",
      "",
      body,
      "",
    ].join("\n");
    fs.writeFileSync(memFile, frontmatter);

    const indexFile = path.join(memDir, ".index");
    fs.appendFileSync(indexFile, JSON.stringify({ id, source: file, file: memFile, at: now }) + "\n");
    // Flag memory as stale so /gk:recall reindexes before its next query.
    try { fs.writeFileSync(path.join(".graphkit", ".memory-dirty"), String(Date.now())); } catch {}
  } catch {
    /* fail-open */
  }
  process.exit(0);
}
main();
