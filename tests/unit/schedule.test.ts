import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import YAML from "yaml";
import { registerScheduleCommands } from "../../src/cli/commands/schedule.js";
import { cronError, emitSchedule, parseCron } from "../../src/compiler/schedule.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { APP_VERSION } from "../../src/version.js";

const SCHEDULED = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: nightly-audit
topology: custom
schedule:
  cron: "0 9 * * 1-5"
  description: Weekday-morning audit sweep
nodes:
  a:
    agent: code-reviewer
    objective: audit
    depend_on: []
    evidence: [report]
evidence:
  required_keys: [report]
`;

function cli() {
  const c = cac("gk").version(APP_VERSION);
  registerScheduleCommands(c);
  c.help();
  return c;
}

function runCli(args: string[], cwd: string) {
  const logs: string[] = [];
  const origLog = console.log;
  const origWrite = process.stdout.write;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  process.stdout.write = ((chunk: unknown) => {
    logs.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  const origCwd = process.cwd;
  process.cwd = () => cwd;
  try {
    cli().parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.stdout.write = origWrite;
    process.cwd = origCwd;
  }
  const code = (process.exitCode as number | undefined) ?? 0;
  process.exitCode = 0;
  return { logs, code };
}

describe("schedule schema", () => {
  test("parses a schedule block and defaults command to exec", () => {
    const doc = YAML.parse(SCHEDULED);
    const parsed = GraphSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schedule?.cron).toBe("0 9 * * 1-5");
      expect(parsed.data.schedule?.command).toBe("exec");
      expect(parsed.data.schedule?.description).toBe("Weekday-morning audit sweep");
    }
  });

  test("graphs without a schedule block still parse (backward compatible)", () => {
    const parsed = GraphSchema.safeParse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "plain" },
      topology: "custom",
      nodes: { a: { agent: "x", objective: "y" } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.schedule).toBeUndefined();
  });

  test("schedule rejects unknown keys (strict object)", () => {
    const parsed = GraphSchema.safeParse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "plain" },
      topology: "custom",
      nodes: { a: { agent: "x", objective: "y" } },
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("cron parsing", () => {
  const VALID = [
    "0 9 * * *",
    "*/15 * * * *",
    "0 9 * * 1-5",
    "30 2 1,15 * *",
    "0 0 1 JAN *",
    "0 9-17/2 * * MON-FRI",
    "0 9 * * 7", // 7 = Sunday, normalizes to 0
    "  0   9 * * *  ", // surrounding whitespace tolerated
  ];
  const INVALID = [
    "0 9 * *", // 4 fields
    "0 9 * * * *", // 6 fields
    "60 * * * *", // minute out of range
    "* 25 * * *", // hour out of range
    "banana",
    "0 9 * * *-",
    "0 9 * */0 *", // step < 1
    "9-5 * * * *", // inverted range
    "0 9 * JAN FOO",
    "@daily", // no shorthand support
  ];
  for (const expr of VALID) {
    test(`accepts "${expr.trim()}"`, () => {
      const r = parseCron(expr);
      expect(r.ok).toBe(true);
      expect(cronError(expr)).toBeNull();
    });
  }
  for (const expr of INVALID) {
    test(`rejects "${expr}"`, () => {
      const r = parseCron(expr);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(typeof r.error).toBe("string");
      expect(cronError(expr)).not.toBeNull();
    });
  }

  test("expands lists, ranges, and steps", () => {
    const r = parseCron("0,30 9-11 * * MON,WED");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.minute).toEqual([0, 30]);
      expect(r.fields.hour).toEqual([9, 10, 11]);
      expect(r.fields.dow).toEqual([1, 3]);
    }
  });
});

describe("schedule-cron validation finding", () => {
  const base = YAML.parse(SCHEDULED) as Record<string, unknown>;

  test("malformed cron produces a blocking schedule-cron finding", () => {
    const graph = GraphSchema.parse({ ...base, schedule: { cron: "0 9 * *" } });
    const findings = validateGraph(graph, "/nonexistent");
    const hit = findings.find((f) => f.check === "schedule-cron");
    expect(hit).toBeDefined();
    expect(hit?.severity).not.toBe("warn");
    expect(hit?.path).toBe("schedule.cron");
  });

  test("well-formed cron produces no schedule-cron finding", () => {
    const graph = GraphSchema.parse(base);
    const findings = validateGraph(graph, "/nonexistent");
    expect(findings.some((f) => f.check === "schedule-cron")).toBe(false);
  });
});

describe("schedule emitters", () => {
  const schedule = { cron: "0 9 * * 1-5", command: "exec" as const, description: "nightly" };

  test("github-actions emits parseable YAML with the declared cron", () => {
    const out = emitSchedule(schedule, "github-actions", "graph.yaml", "nightly-audit");
    const doc = YAML.parse(out);
    expect(doc.on.schedule[0].cron).toBe("0 9 * * 1-5");
    const steps = doc.jobs["scheduled-run"].steps.map((s: { run?: string }) => s.run).filter(Boolean);
    expect(steps.some((r: string) => r.includes("gk exec 'graph.yaml'"))).toBe(true);
  });

  test("cron emits a 5-field crontab line plus command", () => {
    const out = emitSchedule(schedule, "cron", "graph.yaml", "nightly-audit");
    const line = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("#"));
    expect(line).toBeDefined();
    const fields = (line as string).split(/\s+/);
    expect(fields.slice(0, 5)).toEqual(["0", "9", "*", "*", "1-5"]);
    expect(line).toContain("gk exec 'graph.yaml'");
  });

  test("launchd emits a plist with StartCalendarInterval dicts per weekday", () => {
    const out = emitSchedule(schedule, "launchd", "graph.yaml", "nightly-audit");
    expect(out).toContain("<key>StartCalendarInterval</key>");
    // 5 weekdays → an array of 5 dicts, each with Minute/Hour/Weekday.
    expect(out).toContain("<array>");
    expect(out.match(/<key>Weekday<\/key>/g)?.length).toBe(5);
    expect(out).toContain("<key>Minute</key>");
    expect(out).toContain("<key>Hour</key>");
  });

  test("claude-loop emits a /loop markdown snippet carrying the cron", () => {
    const out = emitSchedule(schedule, "claude-loop", "graph.yaml", "nightly-audit");
    expect(out).toContain("/loop 0 9 * * 1-5");
    expect(out).toContain("gk exec 'graph.yaml'");
  });

  test("command: run renders `gk run start --graph`", () => {
    const out = emitSchedule({ ...schedule, command: "run" }, "cron", "graph.yaml", "nightly-audit");
    expect(out).toContain("gk run start --graph 'graph.yaml'");
  });

  test("dense cron fails loudly for launchd (SCHEDULE_DENSE)", () => {
    // */5 minutes × hours 1-10 = 12 × 10 = 120 calendar dicts > the 60 cap.
    expect(() =>
      emitSchedule({ cron: "*/5 1-10 * * *", command: "exec" as const }, "launchd", "graph.yaml", "x"),
    ).toThrow(/SCHEDULE_DENSE/);
  });

  test("every-minute cron emits a single wildcard StartCalendarInterval", () => {
    const out = emitSchedule({ cron: "* * * * *", command: "exec" as const }, "launchd", "graph.yaml", "x");
    expect(out).toContain("<key>StartCalendarInterval</key>");
    expect(out).not.toContain("<key>Minute</key>");
    expect(out).not.toContain("<array>\n      <dict>");
  });
});

describe("gk schedule CLI", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = join(tmpdir(), `gk-sched-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = root;
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), SCHEDULED);
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  // Graph refs go in as absolute paths: existsSync() resolves relative to
  // the real process cwd, not the mocked process.cwd the harness installs.
  const graphFile = () => join(cwd, "graph.yaml");

  test("list prints the declared schedule with schema defaults", () => {
    const { logs, code } = runCli(["schedule", "list", graphFile()], cwd);
    expect(code).toBe(0);
    const text = logs.join("\n");
    expect(text).toContain("0 9 * * 1-5");
    expect(text).toContain("exec");
    expect(text).toContain("Weekday-morning audit sweep");
  });

  test("list --json returns the schedule in the ok envelope", () => {
    const { logs } = runCli(["schedule", "list", graphFile(), "--json"], cwd);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.status).toBe("ok");
    expect(parsed.data.schedule.cron).toBe("0 9 * * 1-5");
    expect(parsed.data.schedule.command).toBe("exec");
  });

  test("list on a graph without schedule fails SCHEDULE_NOT_DECLARED", () => {
    const plain = join(cwd, "plain.yaml");
    writeFileSync(
      plain,
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata: {name: plain}\ntopology: custom\nnodes:\n  a: {agent: x, objective: y}\n`,
    );
    const { logs, code } = runCli(["schedule", "list", plain], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("SCHEDULE_NOT_DECLARED");
  });

  test("emit github-actions writes a valid workflow file to --out", () => {
    const { logs, code } = runCli(
      ["schedule", "emit", graphFile(), "--format", "github-actions", "--out", ".github/workflows/gk-scheduled.yml"],
      cwd,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.status).toBe("ok");
    const doc = YAML.parse(readFileSync(join(cwd, ".github/workflows/gk-scheduled.yml"), "utf-8"));
    expect(doc.on.schedule[0].cron).toBe("0 9 * * 1-5");
  });

  test("emit without --out prints the raw artifact (no JSON envelope)", () => {
    const { logs, code } = runCli(["schedule", "emit", graphFile(), "--format", "cron"], cwd);
    expect(code).toBe(0);
    const text = logs.join("\n");
    expect(text).toContain(`0 9 * * 1-5 cd /ABS/PATH/TO/REPO && gk exec '${graphFile()}'`);
    expect(() => JSON.parse(text)).toThrow();
  });

  test("emit rejects an unknown --format", () => {
    const { logs, code } = runCli(["schedule", "emit", graphFile(), "--format", "systemd"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.error.code).toBe("BAD_FORMAT");
  });

  test("emit requires a file argument", () => {
    const { logs, code } = runCli(["schedule", "emit", "--format", "cron"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.error.code).toBe("MISSING_ARG");
  });

  test("unknown leaf fails with UNKNOWN_SCHEDULE_SUBCOMMAND", () => {
    const { logs, code } = runCli(["schedule", "frobnicate"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.error.code).toBe("UNKNOWN_SCHEDULE_SUBCOMMAND");
  });
});
