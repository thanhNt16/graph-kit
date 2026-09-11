// tests/unit/round4-cli-dx.test.ts
// Round-4 DX batch: gk completions, YAML_INVALID positioning, template list
// tolerance + human table, models overrides corruption guard, AGENTS.md
// unclosed-marker guard.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCompletionsCommand } from "../../src/cli/commands/completions.js";
import { mergeAgentsMd } from "../../src/cli/commands/kit.js";
import { registerModelsCommands } from "../../src/cli/commands/models.js";
import { registerTemplateCommands } from "../../src/cli/commands/template.js";
import { loadGraph } from "../../src/compiler/loader.js";
import { GraphKitError } from "../../src/errors.js";
import { createCliHarness } from "../helpers/cli-harness.js";

describe("gk completions (round 4)", () => {
  test("bash/zsh/fish scripts are generated from the command registry", () => {
    const cli = createCliHarness(registerCompletionsCommand);
    for (const shell of ["bash", "zsh", "fish"]) {
      const run = cli.run(["completions", shell]);
      expect(run.stdout).toContain("graph");
      expect(run.stdout).toContain("memory");
      expect(run.stdout).toContain("completions"); // self-describing surface
    }
    // registry-derived subcommands appear in the group scripts
    expect(cli.run(["completions", "bash"]).stdout).toContain(
      "list switch show topologies inspect new ascii svg waves index search ask trace query",
    );
    expect(cli.run(["completions", "zsh"]).stdout).toContain("compdef _gk gk");
    expect(cli.run(["completions", "fish"]).stdout).toContain("complete -c gk");
  });

  test("missing/unknown shell → MISSING_ARG fail envelope with install hints", () => {
    const cli = createCliHarness(registerCompletionsCommand);
    const run = cli.run(["completions"]);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("MISSING_ARG");
    expect(parsed.error.details.install.join("\n")).toContain("source <(gk completions zsh)");
  });
});

describe("YAML_INVALID positioning (round 4)", () => {
  test("unparseable graph.yaml → YAML_INVALID with file + line/column", () => {
    const dir = join(tmpdir(), `gk-yaml-inv-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const file = join(dir, "graph.yaml");
      writeFileSync(file, "metadata:\n  name: [unclosed\n  topology: diamond\n");
      try {
        loadGraph(file);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(GraphKitError);
        const gke = e as GraphKitError;
        expect(gke.code).toBe("YAML_INVALID");
        expect(gke.details.file).toBe(file);
        expect(typeof gke.details.line).toBe("number");
        expect(gke.details.hint).toBeTruthy();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("template list tolerance + human table (round 4)", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `gk-tpl-r4-${process.pid}-${Date.now()}`);
    mkdirSync(join(root, ".graphkit", "templates"), { recursive: true });
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  const goodTemplate = `apiVersion: graphkit.dev/v1
kind: GraphTemplate
metadata:
  name: sec-audit
  description: Security audit workflow
  version: 1
parameters: {}
recommendations:
  agents: []
  skills: []
  tools: []
  capabilities: []
graph:
  apiVersion: graphkit.dev/v2
  kind: Graph
  metadata:
    name: sec-audit
  topology: diamond
  nodes:
    a:
      agent: reviewer
      objective: audit
      depend_on: []
  evidence:
    required_keys: []
`;

  test("one malformed template no longer bricks the listing — warned and skipped", () => {
    writeFileSync(join(root, ".graphkit", "templates", "good.gk.yaml"), goodTemplate);
    writeFileSync(join(root, ".graphkit", "templates", "bad.gk.yaml"), "not: a: template\n");
    const cli = createCliHarness(registerTemplateCommands, { cwd: root });
    const json = JSON.parse(cli.run(["template", "list", "--json"]).stdout);
    expect(json.status).toBe("ok");
    expect(json.data.templates.map((t: { name: string }) => t.name)).toContain("good");
    expect(json.data.skipped.map((s: { name: string }) => s.name)).toContain("bad");
    const human = cli.run(["template", "list"]).stdout;
    expect(human).toContain("good"); // file stem is the list name
    expect(human).toContain("project"); // origin column the README promises
    expect(human).toContain("Security audit workflow");
  });

  test("bare gk template usage no longer lists the phantom `close` subcommand", () => {
    const cli = createCliHarness(registerTemplateCommands, { cwd: root });
    const out = cli.run(["template"]).stdout;
    expect(out).not.toContain("close");
    expect(out).toContain("pack list show materialize"); // registry order, no phantom
  });
});

describe("models overrides corruption guard (round 4)", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `gk-models-r4-${process.pid}-${Date.now()}`);
    mkdirSync(join(root, ".graphkit"), { recursive: true });
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  test("set over a corrupt overrides file → OVERRIDES_CORRUPT; --force discards", () => {
    writeFileSync(join(root, ".graphkit", "models.cursor.json"), '{ "opus": "broken", }');
    const cli = createCliHarness(registerModelsCommands, { cwd: root });
    const blocked = JSON.parse(cli.run(["models", "cursor", "set", "--map", "opus=x", "--json"]).stdout);
    expect(blocked.status).toBe("fail");
    expect(blocked.error.code).toBe("OVERRIDES_CORRUPT");
    // --force discards and writes
    const forced = JSON.parse(cli.run(["models", "cursor", "set", "--map", "opus=x", "--force", "--json"]).stdout);
    expect(forced.status).toBe("ok");
  });

  test("lowercase 'map' code is gone — MAP_INVALID", () => {
    const cli = createCliHarness(registerModelsCommands, { cwd: root });
    const parsed = JSON.parse(cli.run(["models", "cursor", "set", "--json"]).stdout);
    expect(parsed.error.code).toBe("MAP_INVALID");
  });
});

describe("AGENTS.md merge guards (round 4)", () => {
  const SECTION = "<!-- graphkit:start -->\nrules here\n<!-- graphkit:end -->";

  test("START without END → AGENTS_MD_UNCLOSED, never a duplicated append", () => {
    expect(() => mergeAgentsMd("user notes\n<!-- graphkit:start -->\nstale rules\n", SECTION)).toThrow(/graphkit:end/);
  });

  test("intact markers still refresh in place (regression)", () => {
    const merged = mergeAgentsMd(`user notes\n${SECTION}\n`, SECTION);
    expect(merged.match(/graphkit:start/g)).toHaveLength(1);
    expect(merged).toContain("user notes");
  });
});
