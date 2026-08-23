import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

async function runHook(stdin: string, cwd: string) {
  const proc = Bun.spawn(["node", join(ROOT, "kits", "claude", "hooks", "memory-persist.cjs")], {
    stdin: new Blob([stdin]),
    cwd,
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return { out, code: await proc.exited };
}

function writeEvidence(cwd: string, body: string) {
  const dir = join(cwd, ".graphkit", "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "reviewer.md"), body);
}

function memDir(cwd: string) {
  return join(cwd, ".graphkit", "memory");
}

function memFiles(cwd: string): string[] {
  const d = memDir(cwd);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : [];
}

describe("memory-persist (exec-tests step 2)", () => {
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
    expect(existsSync(memDir(tmp))).toBe(false);
  });

  test("writes OKF memory file + index entry on evidence Write", async () => {
    writeEvidence(tmp, "SQL injection on line 42");
    const evidencePath = ".graphkit/evidence/reviewer.md";
    const { code } = await runHook(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: evidencePath } }),
      tmp,
    );
    expect(code).toBe(0);
    expect(memFiles(tmp).length).toBe(1);
    const idx = readFileSync(join(memDir(tmp), ".index"), "utf-8").trim();
    const entry = JSON.parse(idx);
    expect(entry.source).toBe(evidencePath);
    expect(entry.id).toBeTruthy();
  });

  test("emits additive provenance fields: generated, recorded_at, status, sources", async () => {
    writeEvidence(tmp, "finding body");
    await runHook(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/reviewer.md" } }),
      tmp,
    );
    const raw = readFileSync(join(memDir(tmp), memFiles(tmp)[0]), "utf-8");
    expect(raw).toMatch(/^generated:\s*$/m); // nested map follows
    expect(raw).toContain("by: process:memory-persist");
    expect(raw).toMatch(/recorded_at: \d{4}-\d{2}-\d{2}T/);
    expect(raw.match(/status: (draft|stable|deprecated)/)).toBeTruthy();
    expect(raw).toContain("resource: .graphkit/evidence/reviewer.md");
  });

  test("identical re-capture is idempotent: same single file, no supersession, one index row", async () => {
    writeEvidence(tmp, "unchanged body");
    const ev = JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/reviewer.md" } });
    await runHook(ev, tmp);
    const before = memFiles(tmp).sort();
    await runHook(ev, tmp); // same content again
    expect(memFiles(tmp).sort()).toEqual(before); // skip, not a second file
    const idx = readFileSync(join(memDir(tmp), ".index"), "utf-8")
      .trim()
      .split("\n");
    expect(idx.length).toBe(1);
    const raw = readFileSync(join(memDir(tmp), before[0]), "utf-8");
    expect(raw).not.toContain("superseded_by"); // nothing was superseded
  });

  test("changed same-source content supersedes: predecessor kept with valid_to/superseded_by/status, successor written", async () => {
    writeEvidence(tmp, "first finding version");
    await runHook(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/reviewer.md" } }),
      tmp,
    );
    const firstId = memFiles(tmp)[0].replace(/\.md$/, "");

    writeEvidence(tmp, "second finding version — contradicts the first");
    await runHook(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/reviewer.md" } }),
      tmp,
    );

    const files = memFiles(tmp).sort();
    expect(files.length).toBe(2); // supersede, never overwrite
    const predFile = `${firstId}.md`;
    expect(files).toContain(predFile);
    const succId = files.find((f) => f !== predFile)?.replace(/\.md$/, "");
    expect(succId).toBeTruthy();

    const pred = readFileSync(join(memDir(tmp), predFile), "utf-8");
    expect(pred).toContain(`superseded_by: ${succId}`);
    expect(pred).toMatch(/valid_to: \d{4}-\d{2}-\d{2}T/);
    expect(pred).toContain("status: deprecated");
    expect(pred).toContain("first finding version"); // predecessor body retained

    const succ = readFileSync(join(memDir(tmp), `${succId}.md`), "utf-8");
    expect(succ).not.toContain("superseded_by:");
    expect(succ).toContain("second finding version");
    expect(succ.replace(/\.md$/, "")).not.toBe(firstId); // stable successor id differs
  });

  test("capture id derives from source + body hash (content-hash identity, audit §6-I)", async () => {
    writeEvidence(tmp, "body A");
    await runHook(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/reviewer.md" } }),
      tmp,
    );
    const idA = memFiles(tmp)[0];
    // Same source path, different body → different id (old scheme hashed only the path)
    writeEvidence(tmp, "body B");
    await runHook(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/reviewer.md" } }),
      tmp,
    );
    const ids = memFiles(tmp);
    expect(ids.length).toBe(2);
    expect(ids.filter((f) => f === idA).length).toBe(1);
  });

  test("never writes the dead .memory-dirty flag", async () => {
    writeEvidence(tmp, "dirty check");
    await runHook(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/reviewer.md" } }),
      tmp,
    );
    expect(existsSync(join(tmp, ".graphkit", ".memory-dirty"))).toBe(false);
  });

  test("hook parity: claude and cursor memory-persist are byte-identical", () => {
    const claude = readFileSync(join(ROOT, "kits", "claude", "hooks", "memory-persist.cjs"), "utf-8");
    const cursor = readFileSync(join(ROOT, "kits", "cursor", "hooks", "memory-persist.cjs"), "utf-8");
    expect(cursor).toBe(claude);
  });
});
