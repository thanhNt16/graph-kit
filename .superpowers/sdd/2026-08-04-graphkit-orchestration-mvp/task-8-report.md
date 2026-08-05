# Task 8 Report: Observability and CLI Wiring

## Status

DONE. Implemented in shared worktree `graphkit-mvp`.

## Implemented

- Registered template, workflow, evidence, and manifest CLI command families.
- One JSON result envelope per handler; stable `GraphKitError` codes; non-zero failures.
- Added status, trace, evidence report, Mermaid graph read models.
- Evidence preserves failed submit/reject events, command exit codes, human actions, artifacts, elapsed time, branch state.
- Added CLI manifest generator plus parity integration coverage.
- Added workflow event details for submit output and deterministic command execution.
- `workflow status` uses checkpoint-aware `resumeRun`.

## Test evidence (actual command output)

```
$ bun test tests/integration/cli.test.ts
 13 pass
 0 fail
 102 expect() calls

$ bun test
 147 pass
 0 fail
 467 expect() calls
 Ran 147 tests across 13 files. [17.31s]

$ bun run typecheck
$ tsc --noEmit

$ bun run lint
$ biome check .
Checked 45 files in 26ms. No fixes applied.

$ bun run build
$ bun build src/index.ts --target=node --outdir=dist
Bundled 281 modules in 48ms
  index.js  1.16 MB  (entry point)
```

## Concerns

- Mermaid output is intentionally minimal static topology plus status; no terminal styling.
- Evidence artifacts expose all state keys, including internal input/fanout snapshots, preserving append-only observability rather than hiding data.

---

## Fix round 1 (review: Critical/Important)

## Status

DONE. Commits `cec26b4` (code), report appended.

## Addressed

1. CRITICAL — `workflow graph <run-id> --format mermaid` registered; only `mermaid` supported; unsupported format emits stable `SCHEMA_VIOLATION`, one envelope, nonzero. Tests exact invocation + unknown format.
2. CRITICAL — single source of truth: `CLI_COMMANDS` descriptor array (full leaf path, description, option specs with flag/description/required/default). `cliManifest` and `generateCliManifest` derive solely from descriptors; `COMMAND_NAMES` derived. Parity tests compare descriptor-driven manifest against cac introspection + committed file byte-equivalence; drift caught at leaf path and option level.
3. IMPORTANT — `branches.failed` now uses stable item identity (`work_item ?? lease ?? node`) so identical worker nodes don't collapse; includes failed command exit codes, expired leases, stale active leases (`expires_at <= now`), reject/failed-submit identities; append-only so later success never erases failures. Tests: failed command branch, stale active lease branch without `next`, two distinct failed work items, retry preserves failure.
4. IMPORTANT — sensitive logging: submit events persist only a sanitized receipt (`verdict`, `work_item`, `artifact_keys`) — never output payload; command events persist `executable` (basename), `node`, `exit_code` — never argv/args. `outputHash` (stdlib SHA-256) exported for future use. Tests: secret submit value absent from events.jsonl and evidence; secret argv absent, `executable`/`exit_code` present.
5. FAILURE CHANNEL — all errors (parse/unknown option/unknown command) emit exactly one stdout JSON envelope; stderr empty for JSON mode. `index.ts` catches cac throw pairs and uncaught exceptions, suppresses cac's stderr default via error boundary. Tests: unknown option one stdout envelope, nonzero, no stderr JSON.
6. FIXED — trace-order test asserts exact `seq === index` and exact event-type sequence, not self-sorted.
7. IMPORTANT — Mermaid escapes: node ids mapped to deterministic injective `n0..nN` (`escapeNodeId`), original id + class as quoted label; edge/status labels quoted. Tests: unusual node id with spaces/quotes produces deterministic quoted output.

## Test evidence (actual command output)

```
$ bun test tests/integration/cli.test.ts
 24 pass
 0 fail
 130 expect() calls

$ bun test
 158 pass
 0 fail
 484 expect() calls
 Ran 158 tests across 13 files. [18.66s]

$ bun run typecheck
$ tsc --noEmit

$ bun run lint
$ biome check .
Checked 45 files in 47ms. No fixes applied.

$ bun run build
$ bun build src/index.ts --target=node --outdir=dist
  index.js  1.17 MB  (entry point)
```
