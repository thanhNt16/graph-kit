import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../../src/evidence/fingerprint.js";

const dirs: string[] = [];
function mk(): string {
  const d = join(tmpdir(), `gk-fp-${process.pid}-${Date.now()}-${dirs.length}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("fingerprint", () => {
  test("non-git dir → nulls", () => {
    expect(fingerprint(mk())).toEqual({ head: null, tree: null });
  });

  test("stable across calls; commit moves head; edit moves tree", () => {
    const d = mk();
    const git = (cmd: string) => execSync(cmd, { cwd: d, stdio: "ignore" });
    git("git init -q && git config user.email t@t && git config user.name t");
    writeFileSync(join(d, "a.txt"), "one\n");
    git("git add -A && git commit -qm one");

    const f1 = fingerprint(d);
    const f2 = fingerprint(d);
    expect(f1.head).toMatch(/^[0-9a-f]{40}$/);
    expect(f2).toEqual(f1); // clean tree → same fingerprint twice

    git("git commit -q --allow-empty -m two");
    expect(fingerprint(d).head).not.toBe(f1.head); // head moved

    appendFileSync(join(d, "a.txt"), "two\n");
    const dirty = fingerprint(d);
    expect(dirty.head).toBe(fingerprint(d).head);
    expect(dirty.tree).not.toBeNull(); // dirty file hashed into tree
    expect(fingerprint(d)).toEqual(dirty); // deterministic
  });

  test("untracked file enters tree", () => {
    const d = mk();
    const git = (cmd: string) => execSync(cmd, { cwd: d, stdio: "ignore" });
    git("git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m e");
    const before = fingerprint(d);
    writeFileSync(join(d, "u.txt"), "u\n");
    const after = fingerprint(d);
    expect(after.tree).not.toBe(before.tree);
  });

  test("single-spawn listing ≡ old two-call union (modified + untracked)", () => {
    const d = mk();
    const gitOut = (cmd: string) => execSync(cmd, { cwd: d, encoding: "utf8" });
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: d, stdio: "ignore" });
    writeFileSync(join(d, "a.txt"), "one\n");
    writeFileSync(join(d, "b.txt"), "keep\n");
    writeFileSync(join(d, ".gitignore"), "ignored.txt\n");
    execSync("git add -A && git commit -qm one", { cwd: d, stdio: "ignore" });

    // dirty tracked file + untracked file + an ignored file that must stay out
    appendFileSync(join(d, "a.txt"), "two\n");
    writeFileSync(join(d, "u.txt"), "u\n");
    writeFileSync(join(d, "ignored.txt"), "nope\n");

    // Old implementation: two spawns, newline-split, unioned.
    const changed = gitOut("git ls-files -m").split("\n").filter(Boolean);
    const untracked = gitOut("git ls-files -o --exclude-standard").split("\n").filter(Boolean);
    const oldUnion = [...new Set([...changed, ...untracked])].filter((r) => !r.startsWith(".graphkit/")).sort();
    expect(oldUnion).toEqual(["a.txt", "u.txt"]); // exact expected set

    // New implementation: one spawn, NUL-split.
    const combined = gitOut("git --no-optional-locks ls-files -mo --exclude-standard -z")
      .split("\0")
      .filter(Boolean)
      .filter((r) => !r.startsWith(".graphkit/"))
      .sort();
    expect(combined).toEqual(oldUnion);

    // Fingerprint output identical: tree hash over the same per-file lines.
    const lines = oldUnion.map(
      (rel) =>
        `${rel}:${createHash("sha256")
          .update(readFileSync(join(d, rel)))
          .digest("hex")}`,
    );
    expect(fingerprint(d).tree).toBe(createHash("sha256").update(lines.join("\n")).digest("hex"));
  });
});
