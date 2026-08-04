# GraphKit — Graph Engineering Orchestration MVP (Claude Code first)

Date: 2026-08-04
Status: approved for planning

## 1. Purpose

GraphKit installs a reusable engineering process into coding-agent harnesses. It defines
agentic work as typed nodes connected by controlled edges, and it owns deterministic
control of that graph while the harness supplies the intelligence.

The MVP delivers the **orchestration graph** only. The knowledge/evidence graph is
represented as a run-local evidence record; a full knowledge-graph store is out of scope
and will be integrated later through the `graph` node type.

## 2. Boundary

```
Claude Code harness            gk CLI (TypeScript/Bun)
──────────────────             ─────────────────────────
intelligence                   authority
spawns subagents/teams         owns edges, limits, state
does agent-node work           validates every submission
                    ─── contract JSON ───▶
                    ◀── submit / execute ──
```

Hard invariants:

- gk never invokes a model, spawns an agent, or reads an API key.
- gk issues leases; the harness spawns workers.
- The harness never selects an edge and never raises a limit.
- Every state mutation is schema-validated, merge-policed, provenance-stamped, and checkpointed.

Non-goals for the MVP: knowledge-graph storage/ingest/query/visualization, MCP transport,
daemons, subgraph execution, distributed or remote workers, per-node model routing,
token/cost accounting, harness adapters beyond Claude Code.

## 3. Artifacts

1. **Template package** — versioned on disk: `template.yaml`, `workflow.yaml`, JSON
   schemas, skill sources, policies, replayable tests.
2. **Runtime state** — per run under `.graphkit/runs/<run-id>/`, JSON checkpoints written
   atomically under a lockfile.
3. **Rendered skill** — `SKILL.md` generated from the template for Claude Code, installable
   at project or global scope.

## 4. Repository layout

```
graph-kit/
├── apps/
│   └── gk/
│       ├── src/
│       │   ├── index.ts                 # cac entry
│       │   ├── cli/
│       │   │   ├── command-registry.ts  # all commands registered centrally
│       │   │   └── output.ts            # human + --json envelope
│       │   ├── commands/
│       │   │   ├── template/            # list, inspect, install, new, validate,
│       │   │   │                        # render, diff, update, remove
│       │   │   └── workflow/            # start, next, execute, submit, status,
│       │   │                            # trace, graph
│       │   ├── runtime/
│       │   │   ├── state-machine.ts     # edges, conditions, terminal detection
│       │   │   ├── checkpoints.ts       # atomic temp+rename
│       │   │   ├── leases.ts            # work-item lease lifecycle
│       │   │   ├── merges.ts            # merge policies
│       │   │   ├── validator.ts         # schema, command, policy, file-exists
│       │   │   ├── expression.ts        # ${{ }} substitution + when: predicates
│       │   │   └── provenance.ts
│       │   ├── templates/
│       │   │   ├── loader.ts
│       │   │   ├── registry.ts          # ~/.graphkit/registry.json
│       │   │   └── manifest.ts          # checksums, owned paths
│       │   ├── adapters/
│       │   │   └── claude.ts            # render SKILL.md
│       │   ├── schemas/                 # zod: GraphTemplate, Workflow, RunState
│       │   └── shared/
│       │       ├── lock.ts              # proper-lockfile wrapper
│       │       └── paths.ts             # traversal/symlink safety
│       └── tests/
├── templates/
│   ├── task-execute-verify/
│   └── orchestrator-worker/
│       ├── template.yaml
│       ├── workflow.yaml
│       ├── skills/{orchestrator,worker,evaluator}/SKILL.md
│       ├── schemas/*.schema.json
│       ├── graph/{mappings,seed}.yaml
│       ├── policies/{limits,routing}.yaml
│       └── tests/*.yaml
└── docs/
```

Patterns adopted from `claudekit-cli`: per-command directories with a central registry,
a portable registry keyed by owned paths and checksums, manifest hashing, atomic
temp+rename writes, `proper-lockfile` process locking, Zod validation at trust
boundaries. Patterns adopted from `claudekit-engineer`: authored-source versus rendered-runtime
split, strict `SKILL.md` frontmatter schema, and the bounded-loop safety discipline of `ck-loop`.

Deliberate deviation from `claudekit-cli`: all registry and state writes are atomic
(temp file + rename) from the start.

## 5. Data model

### 5.1 Run directory

```
.graphkit/runs/<run-id>/
├── run.json          # header, cursor, counters
├── state.json        # merged state with per-field provenance
├── checkpoints/      # NNNN-<node>.json, immutable
├── leases.json       # active work-item leases
└── events.jsonl      # append-only: dispatch, submit, reject, command, human, error
```

`run.json` cursor:

```json
{
  "run_id": "run-2026-08-04-abc123",
  "template": "orchestrator-worker@0.1.0",
  "harness": "claude",
  "status": "running",
  "current_nodes": ["execute-workers"],
  "pending_items": ["wi-1", "wi-2"],
  "in_flight": { "wi-3": "lease-a1" },
  "iteration": 1,
  "failures": 0,
  "verdict": null
}
```

### 5.2 Leases

```json
{
  "id": "lease-a1",
  "work_item": "wi-3",
  "node": "execute-workers",
  "issued_at": "2026-08-04T13:40:00Z",
  "expires_at": "2026-08-04T14:10:00Z",
  "status": "active"
}
```

A submission must present a live, unused lease matching the work item. Expired, unknown,
or already-consumed leases are rejected with `LEASE_EXPIRED` / `LEASE_INVALID`, recorded
in `events.jsonl`, and never merged into state.

### 5.3 Write discipline

Every state write satisfies all three:

1. `proper-lockfile` held on the run directory.
2. Temp file plus `rename` — no partial writes.
3. A declared merge policy for the target field. An undeclared concurrent write fails with
   `ERR_UNDECLARED_MERGE`.

### 5.4 Provenance

Each mutation stores `{ run_id, node, lease, actor, timestamp, checkpoint }` alongside the
value it produced.

### 5.5 Command envelope

```json
{ "ok": true, "data": { } }
```

```json
{
  "ok": false,
  "error": {
    "code": "UNBOUNDED_CYCLE",
    "message": "Cycle evaluate → implement → verify → evaluate has no enforced iteration limit.",
    "nodes": ["evaluate", "implement", "verify"],
    "recoverable": true
  }
}
```

`--json` is the machine contract used by the skill. Human output renders the same data.

## 6. Execution protocol

```bash
gk workflow start <template> --input task=...
gk workflow next <run-id> --json
```

`next` returns exactly one of four contracts.

**Agent contract** — node id and type, objective, resolved context references, allowed
tools, output JSON Schema, applicable limits, required evidence keys, and the exact
`gk workflow submit` command to call.

**Dispatch contract** — the ready work items, one lease per item, the worker skill name,
the concurrency ceiling, and the join/merge policy that will apply at fan-in.

**Deterministic contract** — the command, validator, or graph operation, plus the exact
`gk workflow execute` command.

**Paused or terminal contract** — allowed human actions, or the final verdict with the
evidence report location.

Skill loop:

```
next
├─ agent          → perform work → submit
├─ dispatch       → spawn bounded parallel subagents or an agent team
│                   → each worker submits its own result with its lease
├─ deterministic  → execute
├─ human          → ask the user → submit the recorded action
└─ terminal       → produce the evidence report → stop
```

Authority rules:

- The skill never picks an edge and never raises a limit.
- `submit` schema-validates before mutating state.
- `execute` runs only operations declared by the template; commands are allowlisted and
  never shell-interpolated from state.
- Fan-in opens only when required leases have settled; the `all-settled` barrier preserves
  both successful and failed branches.
- Retry increments iteration and failure counters before routing.
- Reaching a limit yields terminal `limit-exceeded` or `blocked`; the run is never
  silently extended.
- Human gates persist a paused state resumable by run ID in a later session.

## 7. Templates

### 7.1 Node types

| Type | MVP status |
|---|---|
| `agent` | supported |
| `command` | supported |
| `validator` | supported |
| `router` | supported |
| `graph` | supported (run-local evidence operations) |
| `human` | supported as a resumable paused state |
| `fanout` | supported via leases |
| `join` | supported with explicit merge policy |
| `aggregator` | agent node with an aggregation contract |
| `tool` | contract recorded; the harness performs the call |
| `subgraph` | deferred |

### 7.2 Edge types

Sequential, conditional (`when:`), fallback (`on_error:`), bounded retry, fan-out, fan-in,
human escalation, and terminal edges carrying verdicts `passed`, `failed`, `blocked`,
`cancelled`, or `limit-exceeded`.

### 7.3 Expressions

`${{ }}` substitution and `when:` predicates evaluate over `inputs`, `state`, `nodes`,
`run`, and `limits`. The expression surface is deliberately non-Turing-complete:
property access, comparison, boolean combination, and null checks only.

### 7.4 Merge policies

`replace`, `append`, `append_unique` (with `identity`), `first`, `maximum`, `minimum`,
`merge_object`, `reject_conflict`. Concurrent writes to a field without a declared policy
are rejected.

### 7.5 Validation

`gk template validate` checks manifest syntax, unique node IDs, a valid start node, a
reachable terminal node, missing edges, unsupported node types, invalid condition
references, unbounded cycles, loops without a maximum iteration count, fan-out without a
maximum worker count, fan-in without a merge policy, agent nodes without an output schema,
human nodes without allowed actions, graph writes using unsupported node or edge types,
missing required skills, referenced files that do not exist, unreachable states, and
terminal states with outgoing edges. Failures use the shared envelope with structured
codes such as `UNBOUNDED_CYCLE`, `MISSING_MERGE_POLICY`, `UNREACHABLE_TERMINAL`,
`SCHEMA_VIOLATION`.

### 7.6 Bundled templates

1. **task-execute-verify** — evaluator-optimizer loop: load context, plan, implement,
   verify, evaluate, bounded retry, complete or fail.
2. **orchestrator-worker** — plan, route, lease-based fan-out, persist worker results,
   aggregate, verify, evaluate, optional human gate, complete or fail.

## 8. Installation and rendering

```bash
gk template install orchestrator-worker              # project scope (default)
gk template install orchestrator-worker --scope global
gk template render orchestrator-worker --harness claude
gk template diff orchestrator-worker
gk template update orchestrator-worker --dry-run
gk template remove orchestrator-worker
```

Project scope writes `.graphkit/templates/<name>@<version>/` and
`.claude/skills/graphkit-*/SKILL.md`. Global scope writes `~/.graphkit/templates/…` and
`~/.claude/skills/…`. The registry at `~/.graphkit/registry.json` records both scopes with
source and target checksums, the install source, and the exact owned paths.

Rules: project scope wins on collision; `update` refuses to overwrite user-modified files
unless `--force`; `--dry-run` prints the diff; `remove` deletes only owned paths.

Path safety rejects `..` segments, absolute segments, URL-encoded traversal, and symlinks
resolving outside the project or `$HOME`. Installs snapshot targets first and roll back in
reverse order on failure.

Only the Claude Code adapter ships in the MVP. Codex, Cursor, and Pi renderers implement
the same adapter interface later; harness neutrality is proven by the template format, not
by shipping four partially tested renderers.

## 9. Evidence and observability

```bash
gk workflow status <run-id>
gk workflow trace <run-id>
gk workflow graph <run-id> --format mermaid
gk evidence report <run-id>
```

Each run exposes run ID, template and version, harness, current node, iteration, pending
and completed and failed branches, elapsed time, commands executed with exit codes, human
actions, artifacts created, and the final verdict. Failed branches remain in the report
permanently; the event log is append-only.

## 10. Reliability

State is persisted before and after every transition. A completed deterministic command is
not re-run unless the template explicitly allows it. Failed submissions and command results
are stored as evidence. A run resumes from the latest valid checkpoint. Unrecoverable work
routes to a terminal blocked state. Successful branch results survive a sibling branch
failure.

## 11. Testing

- **Unit** — expression evaluation, merge policies, lease lifecycle, validator rules, path
  safety, atomic write behavior.
- **Template replay** — each template ships `tests/*.yaml` describing scripted submissions
  for the valid path, retry path, budget-exceeded path, lease expiry, and a parallel
  conflict. gk replays them headlessly with no model involved.
- **Integration** — full `start → next → submit → … → terminal` runs against both bundled
  templates, plus a crash-mid-run resume from checkpoint.
- **Gate** — `bun run ci:local` runs typecheck, lint, build, tests, `gk template validate`
  against both bundled templates, and CLI help/manifest parity checks.

## 12. Acceptance criteria

1. A template defines nodes and edges independently of any harness.
2. `gk template validate` passes for both bundled templates and rejects unreachable nodes
   and unbounded loops.
3. The Claude Code adapter renders working skills at project and global scope.
4. A harness can execute every agent node through the skill protocol without gk invoking a
   model.
5. gk controls every state transition and edge selection.
6. A workflow branches on a submitted structured result.
7. A workflow retries through a bounded cycle and terminates at its limit.
8. A workflow pauses at a human gate and resumes in a later session by run ID.
9. Parallel workers acquire distinct leases; results merge only under a declared policy.
10. A stale or duplicated lease submission is rejected and logged.
11. Every transition produces a checkpoint and every mutation carries provenance.
12. A failed branch remains visible in the evidence report.
13. A run renders as Mermaid.
14. A user forks and customizes a bundled template without modifying gk source.

## 13. Deferred

Knowledge-graph storage, ingest, query, and visualization; MCP transport; additional
harness adapters; subgraph execution; distributed or remote workers; live dashboard;
per-node model routing; token and cost accounting; asynchronous steering of running
workers.
