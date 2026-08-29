import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function readSkill(kit: "claude" | "cursor", name: string): string {
  return readFileSync(join(ROOT, "kits", kit, "skills", name, "SKILL.md"), "utf-8");
}

describe("gk-template skill", () => {
  const claude = readSkill("claude", "gk-template");
  const cursor = readSkill("cursor", "gk-template");

  test("claude has valid frontmatter and name", () => {
    expect(claude).toContain("name: gk:template");
    expect(claude).toContain("user-invocable: true");
  });

  test("claude flow: validate, smallest params, inventory, approve, then pack", () => {
    expect(claude).toContain("gk validate graph.yaml --json");
    expect(claude).toContain("gk inventory --target claude --json");
    expect(claude).toContain("gk template pack");
    expect(claude).toContain("only after approval");
  });

  test("claude never modifies source graph", () => {
    expect(claude).toContain("Never modify the source graph");
    expect(claude).toContain("read-only");
  });

  test("cursor frontmatter and inventory target", () => {
    expect(cursor).toContain("name: gk-template");
    expect(cursor).toContain("gk inventory --target cursor --json");
  });

  test("claude/cursor parity: shared flow lines identical", () => {
    for (const line of [
      "gk validate graph.yaml --json",
      "gk template pack",
      "only after approval",
      "Never modify the source graph",
      "Do not parameterize structural values",
    ]) {
      expect(claude).toContain(line);
      expect(cursor).toContain(line);
    }
  });
});

describe("gk-init-graph skill", () => {
  const claude = readSkill("claude", "gk-init-graph");
  const cursor = readSkill("cursor", "gk-init-graph");

  test("packaged-template resolution + inventory", () => {
    expect(claude).toContain("gk template list");
    expect(claude).toContain("gk template show");
    expect(claude).toContain("gk inventory --target claude --json");
    expect(cursor).toContain("gk inventory --target cursor --json");
  });

  test("installed-only suggestions + model approval", () => {
    expect(claude).toContain("install required");
    expect(claude).toContain("Model changes always require approval");
  });

  test("overwrite approval + materialize + validate", () => {
    expect(claude).toContain("Refuse an existing `graph.yaml` unless the user explicitly approves replacement");
    expect(claude).toContain("gk graph new");
    expect(claude).toContain("gk validate graph.yaml --json");
  });

  test("preserves canonical topology routing", () => {
    expect(claude).toContain("research-and-build");
    expect(claude).toContain("custom");
  });

  test("claude/cursor parity", () => {
    expect(claude).toContain("gk template list");
    expect(cursor).toContain("gk template list");
    expect(claude).toContain("install required");
    expect(cursor).toContain("install required");
    expect(claude).toContain("Model changes always require approval");
    expect(cursor).toContain("Model changes always require approval");
  });
});

describe("gk-visualize skill", () => {
  const claude = readSkill("claude", "gk-visualize");
  const cursor = readSkill("cursor", "gk-visualize");

  test("archify HTML default + explicit modes preserved", () => {
    expect(claude).toContain("Archify HTML");
    expect(claude).toContain("/gk:visualize --ascii");
    expect(claude).toContain("/gk:visualize --svg");
    expect(claude).toContain("/gk:visualize --excalidraw");
  });

  test("install consent + doctor check + SVG fallback", () => {
    expect(claude).toContain("npx -y skills add tt-a1i/archify -g");
    expect(claude).toContain("ask the user once");
    expect(claude).toContain("doctor");
    expect(claude).toContain("fall back to the SVG mode");
  });

  test("validate-before-deliver loop with showcase gate", () => {
    expect(claude).toContain("--quality showcase --json");
    expect(claude).toContain("Non-zero exit is never success");
    expect(claude).toContain("9 artifact checks");
    expect(claude).toContain("Cap at 5 cycles");
  });

  test("no interactive viewer remnants", () => {
    expect(claude).not.toContain("127.0.0.1");
    expect(claude).not.toContain("Server-Sent Events");
    expect(cursor).not.toContain("127.0.0.1");
  });

  test("claude/cursor parity", () => {
    expect(claude).toContain("Archify HTML");
    expect(cursor).toContain("Archify HTML");
    expect(claude).toContain("archify-ir.md");
    expect(cursor).toContain("archify-ir.md");
    expect(cursor).toContain("gk-visualize --svg");
  });
});
