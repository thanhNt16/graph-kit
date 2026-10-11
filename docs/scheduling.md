# Scheduling — the automation heartbeat

A loop is not a loop until something *starts* it on a cadence. GraphKit has
bounded loops and verifiable stop conditions inside a run; the `schedule:`
block closes the other half — declaring **when** a graph should run and
emitting the artifact a real scheduler executes.

```yaml
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: nightly-audit
topology: diamond
schedule:
  cron: "0 9 * * 1-5"          # required — 5-field cron (min hour dom month dow)
  command: exec                # optional: exec (default) | run
  description: Weekday-morning audit sweep   # optional
nodes:
  # ...
```

`gk validate` enforces the cron as the `schedule-cron` check — a malformed
expression is a **blocking** finding, because every emitter codegens directly
from it.

## The honest boundary: no daemon

`gk` is a local CLI. There is no scheduler daemon, no event triggers, no
file-watch. The heartbeat is **declared** in the graph and **materialized** as
a platform-native artifact you hand to a scheduler that already exists:
crond, GitHub Actions, launchd, or a Claude Code `/loop`. Reactive triggers
(webhooks, "run on file change") are a separate roadmap item.

## Findings-inbox semantics

A scheduled run is a *triage inbox*, not a notification firehose. The
convention: a run that produces no new evidence exits quietly. Wire the
heartbeat's exit path through `gk gate`:

- `gk exec` leaves evidence under `outputs.evidence_dir` (default
  `.graphkit/evidence/`).
- `gk gate` exits non-zero when required evidence is missing — so in CI the
  job fails only when the run produced nothing verifiable; in a crontab,
  append `&& gk gate` or mail on failure only.

```bash
gk schedule emit graph.yaml --format github-actions > .github/workflows/gk-scheduled.yml
```

The generated workflow already ends with a `gk gate --json` step for exactly
this reason.

## Commands

```bash
gk schedule list [file]                 # the declared schedule (--json for the envelope)
gk schedule emit <file> --format <fmt>  # artifact on stdout
gk schedule emit <file> --format <fmt> --out <path>
```

`emit` writes the raw artifact to stdout by default (redirect it straight
into its commit path); `--out` writes to a file and replies with the JSON
envelope.

## Formats

### `github-actions`

A commit-ready `.github/workflows/gk-scheduled.yml` shape: `schedule:` trigger
with the graph's cron, `workflow_dispatch` for manual test runs, steps
installing Bun + `graphkit-gk`, running `gk exec <file>`, then `gk gate`.
Secrets and repo-specific setup belong to the host repo — a comment in the
generated file marks where.

### `cron`

A ready-to-paste crontab line:

```text
0 9 * * 1-5 cd /ABS/PATH/TO/REPO && gk exec graph.yaml
```

Replace `/ABS/PATH/TO/REPO`. Cron's PATH is minimal — prefer an absolute path
to `gk` in real crontabs.

### `launchd`

A macOS plist using `StartCalendarInterval` — one `<dict>` per firing (cron
expands to concrete calendar entries). Two honest limits:

- `* * * * *` emits one empty dict (launchd's "every minute").
- Dense crons expanding past 60 calendar entries fail with `SCHEDULE_DENSE` —
  use `--format cron` instead.
- Cron's "day-of-month OR day-of-week" semantics can't be expressed in one
  plist; when both are restricted the emitted file carries a comment noting
  the AND approximation.

### `claude-loop`

A short Markdown snippet showing how Claude Code's `/loop` primitive drives
the same cadence from inside a live session — useful for interactive
heartbeats, not unattended ones.

## `command: exec` vs `command: run`

- `exec` (default): artifacts render `gk exec <graph>` — the headless runner.
  Add `--yes` to auto-approve gate nodes and `--no-judge` where the host has
  no judge available.
- `run`: artifacts render `gk run start --graph <graph>` — opens a ledger run
  for orchestrator-driven execution.
