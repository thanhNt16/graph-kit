import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { graphTemplate } from "../../src/cli/commands/graph.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { TOPOLOGY_NAMES } from "../../src/schemas/topology/index.js";

// V1 regression guard: every scaffold `gk graph new <t>` emits must pass the
// same validate-before-execution gate the quickstart runs at step 3.
describe("scaffolds validate clean", () => {
  for (const topology of TOPOLOGY_NAMES) {
    test(`${topology}: schema-valid and 0 findings`, () => {
      const doc = YAML.parse(graphTemplate(topology as never));
      const parsed = GraphSchema.safeParse(doc);
      expect(parsed.success).toBe(true);
      const dir = mkdtempSync(join(tmpdir(), "gk-scaffold-"));
      const findings = validateGraph(parsed.data as never, dir);
      expect(findings).toEqual([]);
    });
  }
});

// Strict schemas: unknown keys must fail loudly instead of being stripped
// silently — a template author's typo has to name the offending key.
describe("strict schema rejects unknown keys", () => {
  test("unknown top-level key rejected, key named in issue", () => {
    const doc = YAML.parse(graphTemplate("diamond"));
    doc.polic_ref = true;
    const parsed = GraphSchema.safeParse(doc);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.code === "unrecognized_keys" && i.message.includes("polic_ref"))).toBe(
        true,
      );
    }
  });

  test("unknown key inside a node rejected, key named with node path", () => {
    const doc = YAML.parse(graphTemplate("diamond"));
    const firstNode = Object.keys(doc.nodes)[0];
    doc.nodes[firstNode].requried = true;
    const parsed = GraphSchema.safeParse(doc);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // loadGraph surfaces `path: message` — the CLI diagnostic must name the key
      const surfaced = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      expect(surfaced.some((s) => s === `nodes.${firstNode}: Unrecognized key: "requried"`)).toBe(true);
    }
  });
});
