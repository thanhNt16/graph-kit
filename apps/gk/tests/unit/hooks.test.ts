import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hooksDir = join(import.meta.dir, "..", "..", "claude", "hooks");

async function runHook(hookName: string, stdin: string, cwd: string) {
  const proc = Bun.spawn(["node", join(hooksDir, hookName)], {
    stdin: new Blob([stdin]),
    cwd,
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

describe("graph-state-guard", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gk-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("exits 0 on malformed input (fail-open)", async () => {
    const { code } = await runHook("graph-state-guard.cjs", "not json", tmp);
    expect(code).toBe(0);
  });

  test("exits 0 on empty stdin (fail-open)", async () => {
    const { code } = await runHook("graph-state-guard.cjs", "", tmp);
    expect(code).toBe(0);
  });

  test("exits 0 on unknown tool_name (fail-open)", async () => {
    const { code } = await runHook("graph-state-guard.cjs", JSON.stringify({ tool_name: "Bash" }), tmp);
    expect(code).toBe(0);
  });

  test("allows Write to evidence when no active run", async () => {
    const { code, out } = await runHook(
      "graph-state-guard.cjs",
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/x.md" } }),
      tmp,
    );
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("blocks Write to evidence when .active marker exists", async () => {
    mkdirSync(join(tmp, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(tmp, ".graphkit", "runs", ".active"), "");
    const { code, out } = await runHook(
      "graph-state-guard.cjs",
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/x.md" } }),
      tmp,
    );
    expect(code).toBe(0);
    const decision = JSON.parse(out);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("workflow-owned");
  });

  test("blocks Edit to evidence when .active marker exists", async () => {
    mkdirSync(join(tmp, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(tmp, ".graphkit", "runs", ".active"), "");
    const { code, out } = await runHook(
      "graph-state-guard.cjs",
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: ".graphkit/evidence/y.md" } }),
      tmp,
    );
    expect(code).toBe(0);
    const decision = JSON.parse(out);
    expect(decision.decision).toBe("block");
  });

  test("allows Write to non-evidence path even with .active marker", async () => {
    mkdirSync(join(tmp, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(tmp, ".graphkit", "runs", ".active"), "");
    const { code, out } = await runHook(
      "graph-state-guard.cjs",
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/index.ts" } }),
      tmp,
    );
    expect(code).toBe(0);
    expect(out).toBe("");
  });
});

describe("evidence-persist", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gk-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("exits 0 on malformed input (fail-open)", async () => {
    const { code } = await runHook("evidence-persist.cjs", "not json", tmp);
    expect(code).toBe(0);
  });

  test("exits 0 on empty stdin (fail-open)", async () => {
    const { code } = await runHook("evidence-persist.cjs", "", tmp);
    expect(code).toBe(0);
  });

  test("exits 0 on unknown tool_name (fail-open)", async () => {
    const { code } = await runHook("evidence-persist.cjs", JSON.stringify({ tool_name: "Read" }), tmp);
    expect(code).toBe(0);
  });

  test("ignores Write to non-evidence path", async () => {
    const { code } = await runHook(
      "evidence-persist.cjs",
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/foo.ts" } }),
      tmp,
    );
    expect(code).toBe(0);
    expect(existsSync(join(tmp, ".graphkit", "evidence", ".index"))).toBe(false);
  });

  test("indexes evidence Write to .index file", async () => {
    const { code } = await runHook(
      "evidence-persist.cjs",
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/node1.md" } }),
      tmp,
    );
    expect(code).toBe(0);
    const indexPath = join(tmp, ".graphkit", "evidence", ".index");
    expect(existsSync(indexPath)).toBe(true);
    const lines = readFileSync(indexPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.file).toBe(".graphkit/evidence/node1.md");
    expect(entry.at).toBeTruthy();
  });

  test("appends multiple evidence writes", async () => {
    await runHook(
      "evidence-persist.cjs",
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/a.md" } }),
      tmp,
    );
    await runHook(
      "evidence-persist.cjs",
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".graphkit/evidence/b.md" } }),
      tmp,
    );
    const lines = readFileSync(join(tmp, ".graphkit", "evidence", ".index"), "utf-8")
      .trim()
      .split("\n");
    expect(lines.length).toBe(2);
  });
});

describe("lease-enforce", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gk-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("exits 0 on malformed input (fail-open)", async () => {
    const { code } = await runHook("lease-enforce.cjs", "not json", tmp);
    expect(code).toBe(0);
  });

  test("exits 0 on empty stdin (fail-open)", async () => {
    const { code } = await runHook("lease-enforce.cjs", "", tmp);
    expect(code).toBe(0);
  });

  test("exits 0 with no output when no run file exists", async () => {
    const { code, out } = await runHook("lease-enforce.cjs", JSON.stringify({}), tmp);
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("exits 0 with no output when run has empty constraints", async () => {
    mkdirSync(join(tmp, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(tmp, ".graphkit", "runs", "current.json"), JSON.stringify({ constraints: {} }));
    const { code, out } = await runHook("lease-enforce.cjs", JSON.stringify({}), tmp);
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("injects constraints into additionalContext", async () => {
    mkdirSync(join(tmp, ".graphkit", "runs"), { recursive: true });
    writeFileSync(
      join(tmp, ".graphkit", "runs", "current.json"),
      JSON.stringify({ constraints: { assigned_only: true, no_write: false } }),
    );
    const { code, out } = await runHook("lease-enforce.cjs", JSON.stringify({}), tmp);
    expect(code).toBe(0);
    const decision = JSON.parse(out);
    expect(decision.additionalContext).toContain("assigned_only");
    expect(decision.additionalContext).toContain("no_write");
  });
});
