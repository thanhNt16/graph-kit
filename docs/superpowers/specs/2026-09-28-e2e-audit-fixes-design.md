# E2E Audit Fixes — Design

Source: 8-agent E2E audit of gk 0.3.31 (`.tmp-audit/*/FINDINGS.md`) + prior dispatch-comparison run (`.tmp-e2e/reports/e2e-comparison.md`). All findings reproduced with real CLI runs unless marked source-traced.

## Defect list → fix decisions

### C1 — CLI hardening (`src/index.ts`)
- `cli.parse()` unguarded → raw CACError stack on any unknown flag / missing option value (all 56 paths). **Fix:** wrap parse in try/catch → `cli.outputHelp()` + stderr `CACError` message, exit 1. JSON-mode unaffected (envelope commands already emit envelopes).
- `gk <bogus>` prints help + exit 1 with no "unknown command" line. **Fix:** F1 branch prints `Unknown command: <arg>` first.
- Deferred (accepted, not fixing now): leaf `--help` = group help (cac limitation), `--version` swallowed on matched commands, `--json` ignored on bare groups, bare-group exit 0 vs bare-root exit 1 asymmetry.

### C2 — Ledger node/pid/graph integrity (`src/cli/commands/run.ts`, `src/memory/ledger.ts`, `src/run/resume.ts`)
- Phantom nodes: `run node|land|dispatch` accept ids absent from the graph → ledger pollution, inflated `node_count`. **Fix:** validate node id against the active run's recorded graph (`activeRunGraph`); unknown → `UNKNOWN_NODE` fail. Advisor path already does this — reuse the same resolution.
- `run start` ignores session pointer: requires `<cwd>/graph.yaml` while `validate` honors active session graph. **Fix:** resolution order `--graph` → `graph.yaml` if exists → `loadActiveGraph()` when `.graphkit` store exists (mirrors `resolveBareValidateGraph`); recorded path already lands in meta.
- `take` liveness: `kill(pid,0)` EPERM (alive, foreign-user) treated as dead; `pid 0`/bogus pids block forever. **Fix:** EPERM → alive (refuse); validate pid is positive integer at appendDispatch; `take` skips `pid<=0` entries.
- `land` correctness: stamps `landed` even when node's LATEST trace is fail; accepts any `--commit` string. **Fix:** require latest trace line `status:ok` (not "any ok"); validate commit matches `/^[0-9a-f]{4,40}$/i` → `BAD_COMMIT`.
- take output drops `foreign_evidence`; resume GAP-4 raw ENOENT on deleted graph → wrap with `GRAPH_FILE_NOT_FOUND` + hint; node traced ok without `--evidence` reports misleading "passed with evidence on disk" → reason text fix.

### C3 — Evidence graph resolution + report parity (`src/cli/commands/evidence.ts`, `gate.ts`, `src/evidence/report.ts`, `store.ts`)
- add/report/invalidate hard-load `<cwd>/graph.yaml`. **Fix:** resolve `--graph` (new flag) → active run's recorded graph → `<cwd>/graph.yaml`; evidence dir + key validation use the same graph.
- Report/gate divergence on superseded: gate treats superseded as missing, `evidence report` shows present. **Fix:** `buildViews` marks superseded markers `status: "superseded"` (not present).
- Rejected: rename `.index` → `index.jsonl` (scout's F-02 wrong — `index.jsonl` is the RUNS index in `ledger.ts:53`; evidence store's `.index` is self-consistent).
- Deferred: gate-level foreign-evidence lineage check (spec gap — reconciliation enforces it today; needs spec change first).

### C4 — Graph payload + schema (`src/cli/commands/graph.ts`, `src/cli/node-agents.ts`, `src/schemas/graph.schema.ts`)
- waves payload drops `role`, `eval`, and computed `warnings`. **Fix:** nodeObj carries role/eval verbatim; ok payload gains `warnings` from `validateGraph` findings.
- `gk validate` on `kind: GraphTemplate` → 4-issue noise wall. **Fix:** detect `kind === "GraphTemplate"`, validate via `GraphTemplateSchema`, report `kind: template` + parameters hint.
- `metadata` is `.strict()` (changelog claims open); `inputs.*` defs silently strip unknown keys (non-strict inner object). **Fix:** metadata → `.loose()`/catchall passthrough; inputs value schema → `.loose()` — matches documented open-by-design.
- `gk graph agents` crashes mid-materialization on node id containing `/` (partial gk-*.md left). **Fix:** validate node ids `^[A-Za-z0-9._-]+$` at schema level → SCHEMA_INVALID before materialize.
- `constraints.tools_allowlist`: array form schema-rejected, string form silently ignored; docs claim nonexistent validate gate. **Fix:** honor string/array in `nodeTools`; validate warns on unrecognized constraint values; fix docs claim.
- Duplicate evidence producers / duplicate `required_keys` entries pass silently. **Fix:** validation WARNINGS (not errors — late-binding runs legitimately re-stamp; dedupe required_keys).
- `inputs.required` unenforced. **Fix:** `run start --input k=v` (repeatable) + `inputs` recorded into run meta; start fails `MISSING_INPUTS` listing unsatisfied required keys absent defaults. (Spec gap closed minimally — no template-style interpolation.)
- Foreign-evidence check at gate: deferred (spec gap above).

### C5 — Memory (`src/eval/memory-recall.ts`, `src/cli/commands/memory.ts`, `src/eval/explain-recall.ts`)
- M1 HIGH: generated suggestions use `status: proposed|accepted|dismissed`; recall reader (`toDoc`) expects `draft|stable|deprecated` → all suggestions invisible to recall/touch/trace (malformed). **Fix:** `toDoc` maps suggestion statuses → doc statuses (proposed→draft, accepted→stable, dismissed→deprecated) preserving suggestion semantics; `touchMemory` resolves suggestion files.
- M2: explain dual-lists PPR-linked doc as hit AND rejected. **Fix:** zero-overlap pool excludes `seen` ids.
- M4 cosmetic: recall envelope `top_k` (returned count) collides with `recall_topk` cap → rename field `returned`.

### C6 — Kit init (`src/cli/commands/kit.ts`)
- `init --force` rmSync's destDir before `.gk.json` merge → user config (codingLevel/statusline/custom keys) destroyed, contradicting preserve invariant. **Fix:** read+merge existing `.gk.json` BEFORE destructive reset, or exclude `.gk.json` from wipe.
- kitVersion warning says "predates" for NEWER recorded versions. **Fix:** semver compare → "predates"/"is newer than".
- Accepted as designed (no fix): deletions run every install (kit contract); `kits/claude/.gk.json` dead asset (removed by viewer cleanup anyway); multi-target warning scan.

### C7 — Viewer residue
- `kits/_core/viewer/` (server.mjs ~21k lines w/ stale pre-strictness schema) is orphaned: `src/viewer/` deleted in 0.3.2, changelog claims retirement, yet gen-kits copies it into claude/cursor kits whose metadata deletes it post-install. **Fix:** delete `kits/_core/viewer/`, `kits/claude/viewer/`, `kits/cursor/viewer/`; strip viewer clauses from `scripts/gen-kits.ts` (VIEWER_APPEND, viewer flags, copy rules); scrub viewer references from gk-visualize skill fragments; `gen:kits:check` then guards drift.

## Non-goals
- No new features beyond `--input` minimal enforcement. No spec changes (gate lineage, leaf help) — documented as known gaps. No formatter/lint work by fix agents.
