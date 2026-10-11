import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { emitSchedule } from "../../src/compiler/schedule.js";
import { buildViews, scoreViews } from "../../src/evidence/report.js";
import type { Schedule } from "../../src/schemas/graph.schema.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const sched: Schedule = { cron: "0 9 * * 1-5" };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gk-review-"));
}

describe("schedule emit hardening", () => {
  test("graph ref is shell-quoted in emitted commands and gate step", () => {
    const ref = "graphs/my audit.yaml";
    const wf = emitSchedule(sched, "github-actions", ref, "n");
    expect(wf).toContain(`run: gk exec 'graphs/my audit.yaml'`);
    expect(wf).toContain(`run: gk gate 'graphs/my audit.yaml' --json`);
    const cron = emitSchedule(sched, "cron", "x'$(id)'", "n");
    const line = cron.split("\n").find((l) => l.startsWith("0 9"));
    expect(line).toContain("'\\''"); // ' -> '\'' POSIX escape on the crontab line
    expect(line).toContain("gk exec 'x'");
  });
  test("gate step targets the scheduled graph, not ./graph.yaml", () => {
    const wf = emitSchedule(sched, "github-actions", "audit.yaml", "n");
    expect(wf).toContain("gk gate 'audit.yaml' --json");
  });
  test("line breaks in graph ref are rejected", () => {
    expect(() => emitSchedule(sched, "cron", "ok.yaml\nrm -rf ~", "n")).toThrow(/SCHEDULE_REF_UNSAFE/);
  });
  test("XML metacharacters are escaped in launchd plist", () => {
    const plist = emitSchedule(sched, "launchd", 'a<b>&"c".yaml', "n");
    expect(plist).toContain('<string>a&lt;b&gt;&amp;"c".yaml</string>');
    expect(plist).not.toContain('a<b>&"c".yaml');
  });
  test("looped graphs refuse platform formats, allow run command and claude-loop", () => {
    expect(() => emitSchedule(sched, "github-actions", "g.yaml", "n", true)).toThrow(/SCHEDULE_LOOPS_UNSUPPORTED/);
    expect(() => emitSchedule({ ...sched, command: "run" }, "cron", "g.yaml", "n", true)).not.toThrow();
    const cl = emitSchedule(sched, "claude-loop", "g.yaml", "n", true);
    expect(cl).toContain("gk run start --graph 'g.yaml'");
    expect(cl).not.toContain("gk exec 'g.yaml'");
  });
});

describe("scored report floor", () => {
  const scoredGraph = (required: string[], criteria: { id: string; weight: number }[]) =>
    GraphSchema.parse(
      YAML.parse(`apiVersion: graphkit.dev/v2
kind: Graph
metadata: {name: t}
topology: custom
nodes:
  a: {agent: a, objective: o, depend_on: [], evidence: [a]}
evidence:
  verdict: scored
  threshold: 0.5
  required_keys: [${required.join(",")}]
  criteria: [${criteria.map((c) => `{id: ${c.id}, weight: ${c.weight}}`).join(",")}]
`),
    );
  test("score at threshold with a missing required key reports BLOCK", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "evidence", "tests.md"), "ok\n");
    const g = scoredGraph(["design"], [{ id: "tests", weight: 1 }]);
    const s = scoreViews(cwd, g, buildViews(cwd, g));
    expect(s?.score).toBe(1);
    expect(s?.verdict).toBe("BLOCK");
    expect(s?.floor_reasons.join()).toContain("design");
    rmSync(cwd, { recursive: true, force: true });
  });
  test("score at threshold with all required keys present reports MERGE", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "evidence", "design.md"), "ok\n");
    writeFileSync(join(cwd, ".graphkit", "evidence", "tests.md"), "ok\n");
    const g = scoredGraph(["design"], [{ id: "tests", weight: 1 }]);
    const s = scoreViews(cwd, g, buildViews(cwd, g));
    expect(s?.verdict).toBe("MERGE");
    expect(s?.floor_reasons).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("feature list locking", () => {
  test("sequential passFeature calls retain every completion", async () => {
    const { initFeatureList, passFeature, readFeatureList } = await import("../../src/features/store.js");
    const cwd = tmp();
    const path = join(cwd, "feature-list.json");
    initFeatureList(path, [
      { id: "a", description: "x", passes: false },
      { id: "b", description: "y", passes: false },
    ]);
    passFeature(path, "a");
    passFeature(path, "b");
    const list = readFeatureList(path);
    expect(list.items.every((i) => i.passes)).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });
});
