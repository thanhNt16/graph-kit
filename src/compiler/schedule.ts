import { GraphKitError } from "../errors.js";
import type { Schedule } from "../schemas/graph.schema.js";

/**
 * Schedule compilation: the declared `schedule:` block → platform-native
 * artifacts. Both consumers live here so they can never disagree on what a
 * valid cron is — validate.ts gates the declaration (`schedule-cron`), and
 * `gk schedule emit` codegens from the same parsed fields.
 *
 * Scope is the classic 5-field cron expression (minute hour day-of-month
 * month day-of-week): `*`, single values, `a-b` ranges, comma lists, `/n`
 * steps, and the JAN–DEC / SUN–SAT name aliases. No "@daily" shorthands, no
 * seconds or year fields — the emitters target host schedulers that speak
 * exactly this dialect.
 */

export interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
}

export type CronParse = { ok: true; fields: CronFields } | { ok: false; error: string };

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};
const DOW_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

// `size` is the distinct firing values after normalization — dow accepts
// 0-7 on the wire but 7 folds into 0, leaving 7 real days.
const FIELD_SPECS = [
  { key: "minute", min: 0, max: 59, size: 60, names: {} },
  { key: "hour", min: 0, max: 23, size: 24, names: {} },
  { key: "dom", min: 1, max: 31, size: 31, names: {} },
  { key: "month", min: 1, max: 12, size: 12, names: MONTH_NAMES },
  { key: "dow", min: 0, max: 7, size: 7, names: DOW_NAMES },
] as const;

/** One cron field → its expanded value set (sorted, deduped). `*` expands to
 *  the field's whole range; callers treat "full range" as a wildcard. */
function expandField(
  text: string,
  spec: (typeof FIELD_SPECS)[number],
): { ok: true; values: number[] } | { ok: false; error: string } {
  const values = new Set<number>();
  const atom = (s: string): number | null => {
    const named = spec.names[s.toUpperCase() as keyof typeof spec.names];
    if (named !== undefined) return named;
    if (!/^\d+$/.test(s)) return null;
    return Number(s);
  };
  for (const item of text.split(",")) {
    if (item === "") return { ok: false, error: `empty list item in ${spec.key}` };
    const slash = item.indexOf("/");
    const base = slash === -1 ? item : item.slice(0, slash);
    const stepText = slash === -1 ? null : item.slice(slash + 1);
    const step = stepText === null ? 1 : Number(stepText);
    if (stepText !== null && (!/^\d+$/.test(stepText) || step < 1)) {
      return { ok: false, error: `bad step "${stepText}" in ${spec.key} — steps are /n with n >= 1` };
    }
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = spec.min;
      hi = spec.max;
    } else {
      const dash = base.indexOf("-");
      if (dash === -1) {
        const v = atom(base);
        if (v === null) return { ok: false, error: `bad value "${base}" in ${spec.key}` };
        lo = v;
        hi = stepText === null ? v : spec.max; // `a/n` = a-max stepped
      } else {
        const a = atom(base.slice(0, dash));
        const b = atom(base.slice(dash + 1));
        if (a === null || b === null) return { ok: false, error: `bad range "${base}" in ${spec.key}` };
        if (a > b) return { ok: false, error: `inverted range "${base}" in ${spec.key} (${a} > ${b})` };
        lo = a;
        hi = b;
      }
    }
    for (let v = lo; v <= hi; v += step) {
      // day-of-week accepts both 0 and 7 for Sunday — normalize to 0.
      values.add(spec.key === "dow" && v === 7 ? 0 : v);
    }
  }
  const out = [...values].sort((a, b) => a - b);
  for (const v of out) {
    const bounded = spec.key === "dow" ? v >= 0 && v <= 6 : v >= spec.min && v <= spec.max;
    if (!bounded) return { ok: false, error: `value ${v} out of range in ${spec.key} (${spec.min}-${spec.max})` };
  }
  if (out.length === 0) return { ok: false, error: `empty ${spec.key} field` };
  return { ok: true, values: out };
}

/** Parse a 5-field cron expression into expanded per-field value sets. */
export function parseCron(expr: string): CronParse {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    };
  }
  const fields: Record<string, number[]> = {};
  for (let i = 0; i < FIELD_SPECS.length; i++) {
    const spec = FIELD_SPECS[i];
    const r = expandField(parts[i], spec);
    if (!r.ok) return { ok: false, error: r.error };
    fields[spec.key] = r.values;
  }
  return { ok: true, fields: fields as unknown as CronFields };
}

/** The validate.ts seam: error message for a malformed cron, null when valid. */
export function cronError(expr: string): string | null {
  const r = parseCron(expr);
  return r.ok ? null : r.error;
}

export const SCHEDULE_FORMATS = ["github-actions", "cron", "launchd", "claude-loop"] as const;
export type ScheduleFormat = (typeof SCHEDULE_FORMATS)[number];

/** The shell command a schedule drives. `exec` runs the graph headless;
 *  `run` opens a ledger run the orchestrator then drives. */
function gkCommand(schedule: Schedule, graphRef: string): string {
  return schedule.command === "run" ? `gk run start --graph ${graphRef}` : `gk exec ${graphRef}`;
}

const REPO_PLACEHOLDER = "/ABS/PATH/TO/REPO";

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function emitGithubActions(schedule: Schedule, graphRef: string, graphName: string): string {
  return `# Generated by \`gk schedule emit --format github-actions\` from ${graphRef}.
# Commit as .github/workflows/gk-scheduled.yml.
# Secrets and repo-specific setup (private registries, host-kit install,
# service credentials) belong to the host repo — add them to env:/steps below.
name: gk scheduled — ${graphName}

on:
  schedule:
    - cron: ${yamlQuote(schedule.cron)}
  workflow_dispatch: {} # manual trigger for testing the heartbeat

permissions:
  contents: read

jobs:
  scheduled-run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - name: Install gk
        run: bun add -g graphkit-gk
      - name: Run graph
        # add --yes to auto-approve gate nodes, --no-judge to skip judge fields
        run: ${gkCommand(schedule, graphRef)}
      - name: Evidence gate (fails the job on missing required evidence)
        run: gk gate --json
`;
}

function emitCrontab(schedule: Schedule, graphRef: string): string {
  return `# Generated by \`gk schedule emit --format cron\` from ${graphRef}.
# Paste the line below into \`crontab -e\`. Replace ${REPO_PLACEHOLDER} with the
# repo root containing ${graphRef}, and make sure gk is on the cron PATH
# (cron's PATH is minimal — an absolute gk path is safest).
${schedule.cron} cd ${REPO_PLACEHOLDER} && ${gkCommand(schedule, graphRef)}
`;
}

// launchd needs one StartCalendarInterval dict per firing — cap the
// cartesian expansion so a dense cron fails loudly instead of emitting a
// plist macOS would never load in practice.
const MAX_CALENDAR_ENTRIES = 60;

interface CalendarEntry {
  minute?: number;
  hour?: number;
  day?: number;
  month?: number;
  weekday?: number;
}

function calendarEntries(fields: CronFields): CalendarEntry[] {
  const full = (spec: (typeof FIELD_SPECS)[number], values: number[]) => values.length === spec.size;
  const col = (
    spec: (typeof FIELD_SPECS)[number],
    values: number[],
    key: keyof CalendarEntry,
  ): Partial<CalendarEntry>[] => (full(spec, values) ? [{}] : values.map((v) => ({ [key]: v })));
  const cols = [
    col(FIELD_SPECS[0], fields.minute, "minute"),
    col(FIELD_SPECS[1], fields.hour, "hour"),
    col(FIELD_SPECS[2], fields.dom, "day"),
    col(FIELD_SPECS[3], fields.month, "month"),
    col(FIELD_SPECS[4], fields.dow, "weekday"),
  ];
  const total = cols.reduce((n, c) => n * c.length, 1);
  if (total > MAX_CALENDAR_ENTRIES) {
    throw new GraphKitError(
      "SCHEDULE_DENSE",
      `SCHEDULE_DENSE: cron expands to ${total} calendar entries — launchd needs one StartCalendarInterval dict per firing (max ${MAX_CALENDAR_ENTRIES}). Simplify the schedule or use --format cron.`,
      { entries: total, max: MAX_CALENDAR_ENTRIES },
    );
  }
  let entries: CalendarEntry[] = [{}];
  for (const c of cols) {
    const next: CalendarEntry[] = [];
    for (const e of entries) for (const v of c) next.push({ ...e, ...v });
    entries = next;
  }
  return entries;
}

function plistDict(e: CalendarEntry, indent: string): string {
  const KEYS: Array<[keyof CalendarEntry, string]> = [
    ["minute", "Minute"],
    ["hour", "Hour"],
    ["day", "Day"],
    ["month", "Month"],
    ["weekday", "Weekday"],
  ];
  const lines = KEYS.filter(([k]) => e[k] !== undefined).map(
    ([k, name]) => `${indent}  <key>${name}</key>\n${indent}  <integer>${e[k]}</integer>`,
  );
  return `${indent}<dict>\n${lines.join("\n")}\n${indent}</dict>`;
}

function emitLaunchd(schedule: Schedule, graphRef: string, graphName: string): string {
  const parsed = parseCron(schedule.cron);
  if (!parsed.ok) throw new GraphKitError("SCHEDULE_CRON", `SCHEDULE_CRON: ${parsed.error}`);
  const entries = calendarEntries(parsed.fields);
  const domRestricted = parsed.fields.dom.length < FIELD_SPECS[2].size;
  const dowRestricted = parsed.fields.dow.length < FIELD_SPECS[4].size;
  const approx =
    domRestricted && dowRestricted
      ? `\n     NOTE: this cron restricts BOTH day-of-month and day-of-week — cron\n     fires when EITHER matches; StartCalendarInterval requires BOTH. The\n     expansion below approximates as AND. Split into two plists for exact\n     OR semantics.`
      : "";
  const interval =
    entries.length === 1
      ? plistDict(entries[0], "    ")
      : `    <array>\n${entries.map((e) => plistDict(e, "      ")).join("\n")}\n    </array>`;
  const label = `ai.graphkit.${graphName.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by \`gk schedule emit --format launchd\` from ${graphRef}.
     Install: cp to ~/Library/LaunchAgents/${label}.plist, replace
     ${REPO_PLACEHOLDER}, then \`launchctl load ~/Library/LaunchAgents/${label}.plist\`.${approx} -->
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/gk</string>
        ${schedule.command === "run" ? "<string>run</string>\n        <string>start</string>\n        <string>--graph</string>" : "<string>exec</string>"}
        <string>${graphRef}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_PLACEHOLDER}</string>
    <key>StartCalendarInterval</key>
${interval}
    <key>StandardOutPath</key>
    <string>/tmp/${label}.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/${label}.err</string>
</dict>
</plist>
`;
}

function emitClaudeLoop(schedule: Schedule, graphRef: string, graphName: string): string {
  return `# Schedule "${graphName}" — Claude Code /loop

GraphKit ships no scheduler daemon; a Claude Code session's \`/loop\`
primitive can drive the same cadence while a session is open:

\`\`\`
/loop ${schedule.cron} run \`${gkCommand(schedule, graphRef)}\`; report only new evidence, stay quiet when nothing changed
\`\`\`

- The first argument is the cadence — paste the graph's declared cron
  (\`${schedule.cron}\`) or a natural interval (\`every day at 9am\`).
- Findings-inbox semantics: instruct the loop to exit quietly on a run that
  produces no new evidence; \`gk gate --json\` gives the triage verdict
  (MERGE = inbox item, BLOCK = nothing to report).
- Unlike the emitted crontab/plist artifacts, \`/loop\` lives only as long as
  the host session — use a platform scheduler for unattended cadence.
`;
}

/** Compile a declared schedule into the requested platform artifact. */
export function emitSchedule(schedule: Schedule, format: ScheduleFormat, graphRef: string, graphName: string): string {
  switch (format) {
    case "github-actions":
      return emitGithubActions(schedule, graphRef, graphName);
    case "cron":
      return emitCrontab(schedule, graphRef);
    case "launchd":
      return emitLaunchd(schedule, graphRef, graphName);
    case "claude-loop":
      return emitClaudeLoop(schedule, graphRef, graphName);
  }
}
