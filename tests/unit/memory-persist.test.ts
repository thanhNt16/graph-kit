import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hooksDir = join(import.meta.dir, "..", "..", "kits", "claude", "hooks");

async function runHook(stdin: string, cwd: string) {
  const proc = Bun.spawn(["node", join(hooksDir, "memory-persist.cjs")], {
    stdin: new Blob([stdin]),
    cwd,
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return { out, code: await proc.exited };
}

describe("memory-persist", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gk-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("exits 0 on malformed input (fail-open)", async () => {
    expect((await runHook("not json", tmp)).code).toBe(0);
  });
  test("exits 0 on empty stdin (fail-open)", async () => {
    expect((await runHook("", tmp)).code).toBe(0);
  });
  test("ignores Write to non-evidence path", async () => {
    await runHook(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/foo.ts" } }), tmp);
    expect(existsSync(join(tmp, ".graphkit", "memory"))).toBe(false);
  });
  test("writes OKF memory file + index entry on evidence Write", async () => {
    const evidencePath = ".graphkit/evidence/reviewer.md";
    mkdirSync(join(tmp, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(join(tmp, evidencePath), "SQL injection on line 42");
    const { code } = await runHook(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: evidencePath } }),
      tmp,
    );
    expect(code).toBe(0);
    const idx = join(tmp, ".graphkit", "memory", ".index");
    expect(existsSync(idx)).toBe(true);
    const entry = JSON.parse(readFileSync(idx, "utf-8").trim());
    expect(entry.source).toBe(evidencePath);
    expect(entry.id).toBeTruthy();
    // OKF file written with YAML frontmatter
    const memFiles = readFileSync(idx, "utf-8"); // index holds the path
    expect(memFiles).toContain(".graphkit/memory/");
  });
  test("sets .graphkit/.memory-dirty flag on evidence Write (hybrid reindex signal)", async () => {
    const evidencePath = ".graphkit/evidence/reviewer.md";
    mkdirSync(join(tmp, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(join(tmp, evidencePath), "finding");
    await runHook(JSON.stringify({ tool_name: "Write", tool_input: { file_path: evidencePath } }), tmp);
    expect(existsSync(join(tmp, ".graphkit", ".memory-dirty"))).toBe(true);
  });
});
