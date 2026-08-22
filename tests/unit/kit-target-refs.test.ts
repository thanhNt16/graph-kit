import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const KITS_DIR = join(ROOT, "kits");

// Every kit that ships skills must reference its own target id in
// `gk inventory --target <x>` — a copied-from-another-kit skill pointing at
// the wrong host installs against the wrong capability set.
function walkSkillMd(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkSkillMd(p, out);
    else if (e === "SKILL.md") out.push(p);
  }
  return out;
}

describe("kit --target self-references", () => {
  const kits = readdirSync(KITS_DIR).filter((d) => {
    const p = join(KITS_DIR, d);
    return statSync(p).isDirectory();
  });

  test("every SKILL.md with `--target <x>` uses its own kit dir name", () => {
    const offenders: { file: string; found: string[]; expected: string }[] = [];
    for (const kit of kits) {
      const expected = kit;
      for (const f of walkSkillMd(join(KITS_DIR, kit))) {
        const raw = readFileSync(f, "utf8");
        const targets = [...raw.matchAll(/--target\s+([a-z-]+)/g)].map((m) => m[1]);
        if (targets.length > 0 && targets.some((t) => t !== expected)) {
          offenders.push({ file: f.replace(`${ROOT}/`, ""), found: [...new Set(targets)], expected });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
