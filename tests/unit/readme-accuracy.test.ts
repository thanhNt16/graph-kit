// Round 5 D6: the README's own examples must validate. The "Define a graph"
// yaml block shipped an example that failed `gk validate` — every first-time
// user's first command failed. This guard keeps the doc honest.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGraph } from "../../src/compiler/loader.js";
import { validateGraph } from "../../src/compiler/validate.js";

const README = readFileSync(join(import.meta.dir, "..", "..", "README.md"), "utf-8");

function yamlBlocksAfter(heading: string): string[] {
  const idx = README.indexOf(heading);
  expect(idx).toBeGreaterThan(-1);
  const section = README.slice(idx);
  const blocks: string[] = [];
  const re = /```yaml\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  const stop = section.indexOf("\n## ");
  for (m = re.exec(section); m !== null; m = re.exec(section)) {
    if (stop !== -1 && m.index > stop) break;
    blocks.push(m[1]);
  }
  return blocks;
}

describe("README accuracy", () => {
  test("'Define a graph' example passes gk validate", () => {
    const blocks = yamlBlocksAfter("## Define a graph");
    expect(blocks.length).toBeGreaterThan(0);
    const dir = join(import.meta.dir, ".tmp-readme-example");
    const { mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "claude", "agents"), { recursive: true });
    writeFileSync(join(dir, "claude", "agents", "software-architect.md"), "# SA\n");
    writeFileSync(join(dir, "claude", "agents", "code-reviewer.md"), "# CR\n");
    writeFileSync(join(dir, "graph.yaml"), blocks[0]);
    try {
      const graph = loadGraph(join(dir, "graph.yaml"));
      const findings = validateGraph(graph, dir);
      expect(findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the CLI reference block lists every registry subcommand family", () => {
    // run plan / memory list|show / evidence / completions were absent from the
    // README block after shipping — "abbreviated" didn't cover absent commands.
    for (const needle of [
      "Subcommands: start node end list status plan resume",
      "Subcommands: index trace touch list show recall consolidate",
      "evidence [subcommand]",
      "completions [shell]",
      "--github-actions",
    ]) {
      expect(README).toContain(needle);
    }
  });

  test("the install one-liner version pin is not stale", () => {
    expect(README).not.toMatch(/GK_VERSION=v0\.3\.\d/);
  });
});
