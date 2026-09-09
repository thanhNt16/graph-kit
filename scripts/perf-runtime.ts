/**
 * Runtime perf harness — informational only: no thresholds, no CI wiring.
 *
 * Generates size-tiered synthetic memory stores (50/200/1000/5000 entries) in a
 * temp dir, then times:
 *   1. `expandedRecall` over the synthetic store (src/memory/recall-expanded.ts)
 *   2. `fingerprint` inside this git repo cwd (src/evidence/fingerprint.ts)
 *   3. end-to-end `node dist/index.js memory recall <query>` (skipped with a
 *      note when dist/index.js is missing — this script never builds)
 *
 * Run: `bun run perf`
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fingerprint } from "../src/evidence/fingerprint.js";
import { expandedRecall } from "../src/memory/recall-expanded.js";

const SIZES = [50, 200, 1000, 5000];
const QUERY = "diagram pipeline";
const RECALL_ITERS = 5; // + 1 warmup
const FINGERPRINT_ITERS = 5; // + 1 warmup
const CLI_ITERS = 3;

function timeOp(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function meanMs(fn: () => void, iters: number, warmup = 1): number {
  for (let i = 0; i < warmup; i++) fn();
  let total = 0;
  for (let i = 0; i < iters; i++) total += timeOp(fn);
  return total / iters;
}

/** One synthetic memory entry: valid MemoryFile frontmatter + keyword-rich body. */
function memoryEntry(i: number): string {
  const body = [
    `memory entry ${i}: the diagram pipeline emits wave evidence for node`,
    `${["review", "audit", "scan", "merge", "triage"][i % 5]} and recalls graph output across runs`,
    `with salience decay — filler ${"-".repeat((i % 7) + 1)} term${i % 3}`,
  ].join(" ");
  return `---\nid: mem-${String(i).padStart(5, "0")}\ntype: knowledge\nsalience: ${0.3 + ((i % 7) * 0.1).toFixed(2)}\n---\n\n${body}\n`;
}

/** Synthetic store at <root>/.graphkit/memory (root + patterns/ sublevel). */
function generateStore(root: string, n: number): string {
  const memDir = join(root, ".graphkit", "memory");
  mkdirSync(join(memDir, "patterns"), { recursive: true });
  for (let i = 0; i < n; i++) {
    const name = `mem-${String(i).padStart(5, "0")}.md`;
    // ~1 in 5 entries lives in the patterns/ sublevel, like consolidate leaves.
    writeFileSync(i % 5 === 4 ? join(memDir, "patterns", name) : join(memDir, name), memoryEntry(i));
  }
  return memDir;
}

function main(): void {
  const repoRoot = resolve(import.meta.dir, "..");
  const distCli = join(repoRoot, "dist", "index.js");
  const cliAvailable = existsSync(distCli);
  if (!cliAvailable) {
    console.log(
      `note: dist/index.js not found — skipping CLI end-to-end timing (run \`bun run build\` to enable); never building here`,
    );
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "gk-perf-"));
  try {
    // Fingerprint is store-independent (it times this repo's own git state).
    const fpMs = meanMs(() => fingerprint(repoRoot), FINGERPRINT_ITERS);
    console.log(`\nfingerprint (repo cwd): ${fpMs.toFixed(2)} ms/op (${FINGERPRINT_ITERS} ops + 1 warmup)`);

    const rows: Array<{ n: number; recall: number; cli: number | null }> = [];
    for (const n of SIZES) {
      const storeDir = join(tmpRoot, `store-${n}`);
      generateStore(storeDir, n);
      const memDir = join(storeDir, ".graphkit", "memory");
      const recall = meanMs(() => expandedRecall(memDir, QUERY), RECALL_ITERS);

      let cli: number | null = null;
      if (cliAvailable) {
        const times: number[] = [];
        for (let i = 0; i <= CLI_ITERS; i++) {
          // i === 0 is the warmup (first run pays page-cache/OS costs).
          const start = performance.now();
          const r = spawnSync("node", [distCli, "memory", "recall", QUERY], { cwd: storeDir, encoding: "utf8" });
          const ms = performance.now() - start;
          if (r.status !== 0) break;
          if (i > 0) times.push(ms);
        }
        if (times.length === CLI_ITERS) cli = times.reduce((a, b) => a + b, 0) / times.length;
        else console.log(`note: CLI memory recall failed for n=${n} — skipping that cell`);
      }
      rows.push({ n, recall, cli });
    }

    const cliCol = cliAvailable && rows.every((r) => r.cli !== null);
    console.log(
      cliCol
        ? `\n${"n".padStart(6)}  ${"expandedRecall (ms/op)".padStart(22)}  ${"cli memory recall (ms/op)".padStart(24)}`
        : `\n${"n".padStart(6)}  ${"expandedRecall (ms/op)".padStart(22)}`,
    );
    for (const r of rows) {
      const line = `${String(r.n).padStart(6)}  ${r.recall.toFixed(2).padStart(22)}`;
      console.log(cliCol ? `${line}  ${(r.cli as number).toFixed(2).padStart(24)}` : line);
    }
    console.log(`\nstore: ${tmpRoot} (removed on exit) · query: "${QUERY}" · informational only, no thresholds`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();
