import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

// Absolute path: the subprocess runs with cwd = CWD, so a relative path would
// resolve inside the temp dir instead of the repo.
const CLI = join(process.cwd(), "src", "index.ts");
const CWD = join(process.cwd(), ".tmp-test-memory-cli");
const LOG = join(CWD, ".graphkit", "memory", ".recall-log.jsonl");
const MEM_FILE = join(CWD, ".graphkit", "memory", "auth.md");

function seedMemory(): string {
  const body = `---\nid: mem-auth\nsalience: 0.9\nstatus: stable\n---\nJWT token verification protocol.`;
  writeFileSync(MEM_FILE, body);
  return body;
}

describe("gk memory recall CLI (explain, html, capture log)", () => {
  beforeEach(() => {
    rmSync(CWD, { recursive: true, force: true });
    mkdirSync(join(CWD, ".graphkit", "memory"), { recursive: true });
    seedMemory();
  });

  afterEach(() => {
    rmSync(CWD, { recursive: true, force: true });
  });

  it("--explain renders ASCII with zero side effects", async () => {
    const before = readFileSync(MEM_FILE, "utf-8");
    const out = await $`bun run ${CLI} memory recall "JWT token" --explain`.cwd(CWD).text();
    expect(out).toContain('recall: "JWT token"');
    expect(out).toContain("mem-auth");

    // Zero side effects: no touchMemory reinforcement, no capture log.
    expect(readFileSync(MEM_FILE, "utf-8")).toBe(before);
    expect(existsSync(LOG)).toBe(false);
  });

  it("--explain --json prints the explanation envelope without side effects", async () => {
    const before = readFileSync(MEM_FILE, "utf-8");
    const out = await $`bun run ${CLI} memory recall "JWT token" --explain --json`.cwd(CWD).text();
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.query).toBe("JWT token");
    expect(parsed.data.hits[0].id).toBe("mem-auth");
    expect(parsed.data.hits[0].status).toBe("hit");

    expect(readFileSync(MEM_FILE, "utf-8")).toBe(before);
    expect(existsSync(LOG)).toBe(false);
  });

  it("--explain --html writes the standalone report and prints its path", async () => {
    const out = await $`bun run ${CLI} memory recall "JWT token" --explain --html`.cwd(CWD).text();
    const match = out.match(/\.graphkit\/diagrams\/recall-[^\s]+\.html/);
    expect(match).not.toBeNull();
    const htmlPath = join(CWD, match![0]);
    expect(existsSync(htmlPath)).toBe(true);
    expect(readFileSync(htmlPath, "utf-8")).toContain("<!DOCTYPE html>");

    // Explain mode stays side-effect free even with --html.
    expect(existsSync(LOG)).toBe(false);
  });

  it("standard recall output is unchanged and appends a capture row", async () => {
    const out = await $`bun run ${CLI} memory recall "JWT token" --origin curator`.cwd(CWD).text();
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.query).toBe("JWT token");
    expect(parsed.data.top_k).toBe(1);
    expect(parsed.data.results[0].id).toBe("mem-auth");
    expect(parsed.data.linked).toBe(0);
    expect(parsed.data.recall_topk).toBe(5);

    expect(existsSync(LOG)).toBe(true);
    const entry = JSON.parse(readFileSync(LOG, "utf-8").trim().split("\n")[0]);
    expect(typeof entry.ts).toBe("string");
    expect(entry.query).toBe("JWT token");
    expect(entry.k).toBe(5);
    expect(entry.origin).toBe("curator");
    expect(entry.top).toEqual([{ id: "mem-auth", salience: 0.9 }]);
    expect(entry.injected).toBe(true);
    expect(entry.scanned).toBe(1);
  });

  it("capture log defaults origin to cli and appends one row per recall", async () => {
    await $`bun run ${CLI} memory recall "JWT token"`.cwd(CWD).quiet();
    await $`bun run ${CLI} memory recall "jwt"`.cwd(CWD).quiet();

    const lines = readFileSync(LOG, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.origin).toBe("cli");
    expect(first.top[0].id).toBe("mem-auth");
  });

  it("bare --html without --explain fails with INVALID_OPTION", async () => {
    const out = await $`bun run ${CLI} memory recall "JWT token" --html`.cwd(CWD).nothrow().text();
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("INVALID_OPTION");
    expect(parsed.error.message).toContain("--html requires --explain");
    expect(existsSync(LOG)).toBe(false);
  });
});
