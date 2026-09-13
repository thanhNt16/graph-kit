// Round 5 D2: gallery-rot guard. Every bundled gallery template must
// materialize (parameters satisfied) into a schema-valid graph, and every
// canonical topology must have at least one runnable starting point — either a
// template that materializes that topology, or the same-named template
// (sdd/superpowers/research-and-build execute as `topology: custom`).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { materializeTemplate, runTemplateList } from "../../src/cli/commands/template.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { TOPOLOGY_NAMES } from "../../src/schemas/topology/index.js";

describe("gallery templates", () => {
  const home = mkdtempSync(join(tmpdir(), "gk-gallery-home-"));

  test("every gallery template materializes into a schema-valid graph", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gk-gallery-proj-"));
    mkdirSync(join(cwd, ".graphkit"), { recursive: true });
    try {
      const res = runTemplateList({ cwd, home });
      expect(res.data.skipped).toEqual([]); // a bundled template must never ship malformed
      const bundled = res.data.templates.filter((t) => t.origin === "gallery");
      expect(bundled.length).toBeGreaterThanOrEqual(12);
      for (const t of bundled) {
        const out = materializeTemplate(
          String(t.name),
          { task: "demo workload", workload: "demo", topic: "demo", module: "demo" },
          {
            cwd,
            home,
            use: false,
          },
        );
        const graph = GraphSchema.parse(YAML.parse(require("node:fs").readFileSync(out.path, "utf-8")));
        expect(graph.metadata.name).toBeTruthy();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("every canonical topology has a runnable template starting point", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gk-gallery-proj-"));
    mkdirSync(join(cwd, ".graphkit"), { recursive: true });
    try {
      const res = runTemplateList({ cwd, home });
      const listed = res.data.templates.map((t) => ({
        name: String(t.name),
        topology: t.topology as string | undefined,
      }));
      for (const topology of TOPOLOGY_NAMES) {
        const covered = listed.some((t) => t.topology === topology || t.name === topology);
        expect(covered).toBe(true);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the seven round-5 templates carry their canonical topology", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gk-gallery-proj-"));
    mkdirSync(join(cwd, ".graphkit"), { recursive: true });
    try {
      const res = runTemplateList({ cwd, home });
      const byTopology = new Map(res.data.templates.map((t) => [t.topology as string, t.name]));
      for (const topology of [
        "classify-and-act",
        "adversarial-verification",
        "generate-and-filter",
        "memory-augmented",
      ]) {
        expect(byTopology.get(topology)).toBe(topology);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
