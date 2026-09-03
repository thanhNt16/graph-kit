import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerSuggestCommands } from "../../src/cli/commands/suggest.js";
import { dismissSuggestion, rankSuggestions, readSuggestions } from "../../src/memory/suggest.js";

function suggestion(dir: string, id: string, salience: number, status = "proposed") {
  writeFileSync(
    join(dir, "suggestions", `${id}.md`),
    `---\nid: ${id}\ntype: suggestion\naction: review-failure\nrationale: "node failed 3 times"\nbased_on: [pattern-x]\nstatus: ${status}\nsalience: ${salience}\ncreated_at: 2026-09-01T00:00:00.000Z\nvalid_from: 2026-09-01T00:00:00.000Z\n---\nbody\n`,
  );
}

describe("gk suggest", () => {
  let memDir: string;
  beforeEach(() => {
    const root = join(tmpdir(), `gk-suggest-${process.pid}-${Date.now()}`);
    memDir = join(root, ".graphkit", "memory");
    mkdirSync(join(memDir, "suggestions"), { recursive: true });
  });
  afterEach(() => rmSync(join(memDir, ".."), { recursive: true, force: true }));

  test("reads and ranks by salience desc", () => {
    suggestion(memDir, "suggestion-low", 1.5);
    suggestion(memDir, "suggestion-high", 4.2);
    const ranked = rankSuggestions(readSuggestions(memDir));
    expect(ranked.map((s) => s.id)).toEqual(["suggestion-high", "suggestion-low"]);
  });

  test("dismissed suggestions rank last but are retained on disk", () => {
    suggestion(memDir, "suggestion-gone", 9.9, "dismissed");
    suggestion(memDir, "suggestion-live", 0.1);
    const ranked = rankSuggestions(readSuggestions(memDir));
    expect(ranked[0].id).toBe("suggestion-live");
    expect(ranked).toHaveLength(2);
  });

  test("dismissSuggestion flips status and preserves the body", () => {
    suggestion(memDir, "suggestion-target", 2.0);
    expect(dismissSuggestion(memDir, "suggestion-target", "2026-09-03T00:00:00.000Z")).toBe(true);
    const raw = readFileSync(join(memDir, "suggestions", "suggestion-target.md"), "utf-8");
    expect(raw).toMatch(/^status: dismissed$/m);
    expect(raw.endsWith("body\n")).toBe(true);
  });

  test("dismissSuggestion returns false for unknown id", () => {
    expect(dismissSuggestion(memDir, "suggestion-nope")).toBe(false);
  });
});

function runCli(args: string[], cwd: string) {
  const cli = cac("gk");
  registerSuggestCommands(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  process.chdir(cwd);
  try {
    cli.parse(["node", "gk", "suggest", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
  }
  const code = process.exitCode ?? 0;
  process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
  return { stdout: logs.join("\n"), code };
}

describe("gk suggest CLI", () => {
  let memDir: string;
  beforeEach(() => {
    const root = join(tmpdir(), `gk-suggest-cli-${process.pid}-${Date.now()}`);
    memDir = join(root, ".graphkit", "memory");
    mkdirSync(join(memDir, "suggestions"), { recursive: true });
  });
  afterEach(() => rmSync(join(memDir, ".."), { recursive: true, force: true }));

  test("lists ranked suggestions in terminal format", () => {
    suggestion(memDir, "suggestion-low", 1.5);
    suggestion(memDir, "suggestion-high", 4.2);
    const { stdout, code } = runCli([], join(memDir, "..", ".."));
    expect(code).toBe(0);
    const lines = stdout.split("\n");
    expect(lines[0]).toContain("[review-failure] suggestion-high");
    expect(lines[0]).toContain("salience 4.20");
    expect(lines[2]).toContain("[review-failure] suggestion-low");
  });

  test("emits ok envelope with --json", () => {
    suggestion(memDir, "suggestion-high", 4.2);
    const { stdout } = runCli(["--json"], join(memDir, "..", ".."));
    const envelope = JSON.parse(stdout) as { status: string; data: { count: number; suggestions: { id: string }[] } };
    expect(envelope.status).toBe("ok");
    expect(envelope.data.count).toBe(1);
    expect(envelope.data.suggestions[0].id).toBe("suggestion-high");
  });

  test("hides dismissed by default, includes with --all", () => {
    suggestion(memDir, "suggestion-gone", 9.9, "dismissed");
    suggestion(memDir, "suggestion-live", 0.1);
    const hidden = JSON.parse(runCli(["--json"], join(memDir, "..", "..")).stdout) as { data: { count: number } };
    expect(hidden.data.count).toBe(1);
    const all = JSON.parse(runCli(["--json", "--all"], join(memDir, "..", "..")).stdout) as { data: { count: number } };
    expect(all.data.count).toBe(2);
  });

  test("prints hint on empty suggestions", () => {
    const { stdout } = runCli([], join(memDir, "..", ".."));
    expect(stdout).toContain("No suggestions");
  });

  test("--dismiss flips status via the CLI and reports ok", () => {
    suggestion(memDir, "suggestion-target", 2.0);
    const { stdout, code } = runCli(["--dismiss", "suggestion-target"], join(memDir, "..", ".."));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ status: "ok", data: { dismissed: "suggestion-target" } });
    expect(readFileSync(join(memDir, "suggestions", "suggestion-target.md"), "utf-8")).toMatch(/^status: dismissed$/m);
  });

  test("--dismiss tolerates a malformed sibling file and dismisses the valid target", () => {
    writeFileSync(join(memDir, "suggestions", "aa-broken.md"), "---\n: [unclosed\n---\nbody\n");
    suggestion(memDir, "suggestion-target", 2.0);
    const { stdout, code } = runCli(["--dismiss", "suggestion-target"], join(memDir, "..", ".."));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ status: "ok", data: { dismissed: "suggestion-target" } });
    expect(readFileSync(join(memDir, "suggestions", "suggestion-target.md"), "utf-8")).toMatch(/^status: dismissed$/m);
    // malformed sibling left untouched for consolidate to prune
    expect(readFileSync(join(memDir, "suggestions", "aa-broken.md"), "utf-8")).toBe("---\n: [unclosed\n---\nbody\n");
  });

  test("--dismiss unknown id emits fail envelope with exit code 1", () => {
    const { stdout, code } = runCli(["--dismiss", "suggestion-nope"], join(memDir, "..", ".."));
    expect(code).toBe(1);
    const envelope = JSON.parse(stdout) as { status: string; error: { code: string } };
    expect(envelope.status).toBe("fail");
    expect(envelope.error.code).toBe("SUGGESTION_NOT_FOUND");
  });
});
