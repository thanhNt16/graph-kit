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
