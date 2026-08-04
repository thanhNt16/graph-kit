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
