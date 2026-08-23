#!/usr/bin/env node
// PostToolUse: distill evidence writes into OKF memory files under .graphkit/memory/.
// Identity = basename + sha1(source + body)[:8]; same id → idempotent skip;
// changed same-source content → predecessor superseded (valid_to/superseded_by/
// status: deprecated, body retained), stable successor emitted. Additive fields
// generated/recorded_at/status/sources. Fail-open. No .memory-dirty.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function captureId(src, source, body) {
  const hash = crypto.createHash("sha1").update(source + body).digest("hex").slice(0, 8);
  return `${src}-${hash}`;
}

function readFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  return { m, fm: m ? require("yaml").parse(m[1]) : {} };
}

function main() {
  let input = "";
  try { input = fs.readFileSync(0, "utf-8"); } catch { process.exit(0); }
  try {
    const event = JSON.parse(input);
    if (event.tool_name !== "Write") process.exit(0);
    const file = event.tool_input?.file_path ?? "";
    if (!file.includes(".graphkit/evidence/")) process.exit(0);

    const src = path.basename(file, ".md");
    const body = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    const id = captureId(src, file, body);
    const memDir = ".graphkit/memory";
    const memFile = path.join(memDir, `${id}.md`);
    fs.mkdirSync(memDir, { recursive: true });
    if (fs.existsSync(memFile)) process.exit(0); // identical capture: no write/index row

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
      "generated:",
      "  by: process:memory-persist",
      `  at: ${now}`,
      `recorded_at: ${now}`,
      "status: stable",
      "sources:",
      `  - resource: ${file}`,
      "---",
      "",
      body,
      "",
    ].join("\n");
    fs.writeFileSync(memFile, frontmatter);

    const indexFile = path.join(memDir, ".index");
    fs.appendFileSync(indexFile, JSON.stringify({ id, source: file, file: memFile, at: now }) + "\n");

    // Supersede any prior capture of the same evidence source with different content.
    for (const prev of fs.readdirSync(memDir).filter((f) => f.endsWith(".md") && f !== `${id}.md`)) {
      const prevPath = path.join(memDir, prev);
      const raw = fs.readFileSync(prevPath, "utf-8");
      const { m, fm } = readFrontmatter(raw);
      if (!m || fm.source !== file || fm.id === id) continue;
      fm.superseded_by = id;
      fm.status = "deprecated";
      if (!fm.valid_to) fm.valid_to = now;
      fs.writeFileSync(prevPath, `---\n${require("yaml").stringify(fm)}---\n${raw.slice(m[0].length)}`);
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
}
main();