// tests/unit/dream-template.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const GALLERY = join(import.meta.dir, "..", "..", "templates", "gallery");

describe("dream template", () => {
  const raw = readFileSync(join(GALLERY, "dream.gk.yaml"), "utf-8");
  const tpl = YAML.parse(raw);

  test("is a GraphTemplate named dream with focus/since parameters", () => {
    expect(tpl.kind).toBe("GraphTemplate");
    expect(tpl.metadata.name).toBe("dream");
    expect(tpl.parameters.focus.required).toBe(false);
    expect(tpl.parameters.since.required).toBe(false);
  });

  test("harvest and challenge are write-free; dream writes only to the inbox", () => {
    const flat = (arr: unknown[]) =>
      arr.flatMap((c) => (typeof c === "object" && c ? Object.entries(c as Record<string, unknown>) : []));
    expect(flat(tpl.graph.nodes.harvest.constraints)).toContainEqual(["no_write", true]);
    expect(flat(tpl.graph.nodes.challenge.constraints)).toContainEqual(["no_write", true]);
    expect(flat(tpl.graph.nodes.dream.constraints ?? [])).toEqual([]);
    expect(tpl.graph.nodes.dream.objective).toContain(".graphkit/inbox");
    expect(tpl.graph.nodes.dream.objective).not.toMatch(/memory\/patterns\/|memory\/suggestions\//);
  });

  test("chain is harvest → dream → challenge with an evidence gate", () => {
    expect(tpl.graph.nodes.dream.depend_on).toEqual(["harvest"]);
    expect(tpl.graph.nodes.challenge.depend_on).toEqual(["dream"]);
    expect(tpl.graph.evidence.required_keys).toContain("dream-proposal");
  });
});
