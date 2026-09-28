// sync-omp.ts — mirror kits/_core content into .omp/ (the repo's dogfood copy)
// via the pi target output. Extras unique to .omp (e.g. skills/eli5) are never
// touched unless --prune is passed; --prune still never deletes OMP_LOCAL entries.
//
// Usage:
//   bun run scripts/sync-omp.ts           # copy agents/, skills/, prompts/, extensions/, rules-section.md
//   bun run scripts/sync-omp.ts --prune   # also delete .omp entries absent from the generated output
//   bun run scripts/sync-omp.ts --check   # drift gate: diff .omp vs fresh pi output, exit 1 on any diff
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { generateKit } from "./gen-kits.ts";

const ROOT = resolve(import.meta.dir, "..");
const OMP = join(ROOT, ".omp");
const MIRRORED = ["agents", "skills", "prompts", "extensions"] as const;
// .omp-local entries that --prune must never delete (not generated from _core).
const OMP_LOCAL: Record<(typeof MIRRORED)[number], readonly string[]> = {
  agents: [],
  skills: ["eli5"],
  prompts: [],
  extensions: [],
};

const args = process.argv.slice(2);
const prune = args.includes("--prune");
const check = args.includes("--check");

/** Recursive relative-path → content map for a directory (missing dir → {}). */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(relative(dir, p), readFileSync(p, "utf-8"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Diff two snapshots; returns human-readable difference lines. */
function diffSnapshots(a: Map<string, string>, b: Map<string, string>, label: string): string[] {
  const diffs: string[] = [];
  for (const k of a.keys()) {
    if (!b.has(k)) diffs.push(`${label}: only in .omp: ${k}`);
    else if (a.get(k) !== b.get(k)) diffs.push(`${label}: content differs: ${k}`);
  }
  for (const k of b.keys()) if (!a.has(k)) diffs.push(`${label}: only in generated output: ${k}`);
  return diffs;
}

const staging = mkdtempSync(join(ROOT, ".tmp-sync-omp-"));
try {
  generateKit("pi", staging);
  const src = join(staging, "pi");

  if (check) {
    // .omp is gitignored — the local dogfood mirror is optional. A fresh
    // checkout/CI has no .omp; that's "absent", not "drifted".
    if (!existsSync(OMP)) {
      console.log("sync-omp --check: no .omp (gitignored) — skipped");
      process.exit(0);
    }
    const diffs: string[] = [];
    for (const dir of MIRRORED) {
      const local = snapshot(join(OMP, dir));
      // .omp-local entries are expected extras, not drift.
      for (const extra of OMP_LOCAL[dir]) {
        for (const k of [...local.keys()]) if (k === extra || k.startsWith(`${extra}/`)) local.delete(k);
      }
      diffs.push(...diffSnapshots(local, snapshot(join(src, dir)), dir));
    }
    const localRules = existsSync(join(OMP, "rules-section.md"))
      ? readFileSync(join(OMP, "rules-section.md"), "utf-8")
      : "";
    const genRules = existsSync(join(src, "rules-section.md"))
      ? readFileSync(join(src, "rules-section.md"), "utf-8")
      : "";
    if (localRules !== genRules) diffs.push("rules-section.md: content differs");
    if (diffs.length > 0) {
      console.error(`sync-omp --check: .omp drifted from kits/_core (run \`bun run sync:omp\` to fix):`);
      for (const d of diffs) console.error(`  ${d}`);
      process.exit(1);
    }
    console.log("sync-omp --check: .omp in sync with kits/_core");
    process.exit(0);
  }

  if (!existsSync(OMP)) mkdirSync(OMP, { recursive: true });
  for (const dir of MIRRORED) {
    if (!existsSync(join(src, dir))) continue;
    cpSync(join(src, dir), join(OMP, dir), { recursive: true });
    if (!prune) continue;
    const keep = new Set([...readdirSync(join(src, dir)), ...OMP_LOCAL[dir]]);
    for (const entry of readdirSync(join(OMP, dir))) {
      if (!keep.has(entry)) rmSync(join(OMP, dir, entry), { recursive: true, force: true });
    }
  }
  cpSync(join(src, "rules-section.md"), join(OMP, "rules-section.md"));
  console.log(
    `sync-omp: synced ${MIRRORED.join(", ")}, rules-section.md${prune ? " (pruned)" : ""} from kits/_core via pi target`,
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
