// tests/unit/error-codes-doc.test.ts
// D6 guard: docs/error-codes.md must cover every error code emitted by src/.
// Extraction is call-site based (`fail("X"…` / `new GraphKitError("X"…`),
// whitespace/newline tolerant), matching the public surface rather than any
// uppercase string literal. The doc may document extra codes (e.g. the
// dynamically-derived RUN_ERROR fallback) — it just may not miss any.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const SRC = join(import.meta.dir, "..", "..", "src");
const DOC = join(import.meta.dir, "..", "..", "docs", "error-codes.md");

describe("error-code catalog", () => {
  test("every emitted code is documented (and documented codes are real)", () => {
    const emitted = new Set<string>();
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf-8");
      for (const m of src.matchAll(/(?:\bfail|new GraphKitError)\(\s*"([A-Z][A-Z0-9_]+)"/g)) {
        emitted.add(m[1]);
      }
    }
    const docTable = readFileSync(DOC, "utf-8");
    const documented = new Set<string>();
    for (const line of docTable.split("\n")) {
      const m = line.match(/^\| `([A-Z][A-Z0-9_]+)` \|/);
      if (m) documented.add(m[1]);
    }
    expect(documented.size).toBeGreaterThan(50); // the catalog is substantive

    const missing = [...emitted].filter((c) => !documented.has(c)).sort();
    expect(missing).toEqual([]);

    // Codes in the doc that no call site emits must be explicitly allowed —
    // currently only the RUN_ERROR fallback (built dynamically in run.ts).
    const dynamic = new Set(["RUN_ERROR"]);
    const stale = [...documented].filter((c) => !emitted.has(c) && !dynamic.has(c)).sort();
    expect(stale).toEqual([]);
  });
});
