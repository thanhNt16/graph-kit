# Improvement Round 2 — Design

**Date:** 2026-09-09 · **Branch:** `improvement/efficiency-quality-round2` (stacked on round-1 PR #3)
**Input:** 4-lens parallel brainstorm (graph accuracy, code quality, runtime efficiency, DX). Baseline: 678 tests pass, `ci:local` green at `f11e391`.

## Problem

Round 1 hardened the build and CLI surface. The repo's own metric analysis (`idea-backlog.md`) says
wrong-answer accuracy is 96.5% of the remaining gap; backlog items R5/R6/R7 are still open. Beyond
that, the brainstorm surfaced confirmed defects (mis-anchored trace hops, `touchMemory` dropping
legacy-tag entries, no-op `--json` flags contradicting README) and measurable waste (3× git spawn in
`fingerprint()`, O(5n) reinforcement scans, O(n²) supersede resolution).

## Scope — 16 items, 3 workstreams

### Workstream A — graph/CBM accuracy (R5+R6+R7) + render-path typing
1. **R7** — collapse the four bespoke CBM subcommand bodies (`src/cli/commands/graph.ts` search/ask/trace/query) into one `CBM_ACTIONS` dispatch table + shared runner. Preserves exact error codes (`MISSING_ARG`, `INVALID_LIMIT`, `INVALID_DEPTH`), limit-before-depth validation order for `ask`, `cbmCall` close-on-throw semantics. **Acceptance bar: `tests/unit/graph-cbm-commands.test.ts` passes unchanged.** Adds the currently-missing CLI-level INVALID_LIMIT/INVALID_DEPTH tests.
2. **R6** — new `src/cbm/templates.ts`: `QueryTemplate{description, argHint?, run}` runners (not raw Cypher strings — the CBM dialect is unverifiable while npm 404s, so only proven constructs ship: label MATCH, edge pattern, DISTINCT, ORDER BY, LIMIT; all filtering client-side). Templates: `dead-code` (route.ts:203-230 anti-join **moved verbatim** — single source of truth; `routeAndRetrieve` delegates to it), `callers-of <symbol>`, `symbol-set <file-path>`. CLI: `gk graph query --template <name>` and offline `--templates` listing (no client created); unknown → `UNKNOWN_TEMPLATE` with `available` list. `cli-manifest.json` regenerated. Kit docs: `code-reviewer.md`/`data-engineer.md` gain the "prefer `gk graph ask`; use `--template dead-code` for declared-but-never-used" line — discovery is the accuracy multiplier.
3. **R5** — `TraceHop` gains optional `file_path`/`start_line`/`end_line` (contract.ts, additive so old mocks type-check); `hop()` prefers server coords and fixes the fallback: `pickCandidate` returns the **full** derived candidate when the last qualified-name segment is all-lowercase (file/dir node → today mis-derives `proj.src.cli.commands.graph` → `commands.ts`), the **parent** when camelCase (function tail). `RoutedResult` caller/callee entries gain optional `line`.
4. **Template move** — 515-line `graphTemplate()` verbatim to `src/cli/graph-templates.ts` (pure data).
5. **Typed render path** — `loadGraph`/`resolveBareValidateGraph` → `src/compiler/loader.ts`; `renderSvg`/`renderAscii` take the zod `Graph`; delete `ascii.ts` hand-rolled interfaces; kill 4× `as any` in `svg.ts`. Keep back-compat re-exports from `graph.ts` for test imports.

### Workstream B — memory/ledger quality + perf
6. **Frontmatter helper** — new `src/memory/frontmatter.ts`: `parseMemoryFile(raw, fallbackId)` (legacy string-`tags` coercion + id/type defaults + `MemoryFileSchema.safeParse`) and `walkMemoryStore(memDir)` (root + one sublevel, skip dot-dirs). Re-point `traceMemory`, `touchMemory`, `readMemories`, `suggest.ts`, `links.ts`, `recall-expanded.ts`. **Bug fix:** `touchMemory` gains the legacy-tags coercion `traceMemory` already had (string `tags:` entries silently failed reinforcement). Per-call-site exclusion differences preserved.
7. **Reinforcement O(k)** — `expandedRecall` returns each hit's `path`; new `touchMemoryByPath(cwd, path, id)`; `gk memory recall` touches by path instead of re-scanning the store per hit.
8. **GraphKitError unification** — ~21 raw `Error("CODE: msg")` sites in `ledger.ts`/`resume.ts`/`consolidate.ts` → `GraphKitError(code, message)` (message text byte-identical); `run.ts` `errCode` simplifies to an instanceof check and threads `details` into `fail()`. Plus one `readJsonl<T>` helper replacing the three identical split/parse/skip-torn-line readers in `ledger.ts`.
9. **Supersede dedup** — `resolveSuperseded` O(n²) `Array.some/includes` → `Set` (behavior-identical).

### Workstream C — evidence/DX/perf
10. **Fingerprint** — one `git --no-optional-locks ls-files -mo --exclude-standard -z` spawn replaces two `ls-files` spawns (≈15-20 ms off every `gate`/`status`/`evidence report`/`run start`); sort+dedup preserved; equivalence test.
11. **Human renderers + honest `--json`** — `gate` (verdict line + per-key table by default; sha256 manifest only under `--json`), `status`, `inventory`, `run status`, `memory recall`, `init`/`new` get human-readable defaults; the advertised-but-no-op `--json` flags become functional (envelope unchanged in shape). Fail envelopes stay JSON-on-stdout. Makes README's `gk status  # human-readable` true.
12. **Doctor** — two new deterministic checks: kit-source probe (`kitSourceDir()` per detected target; catches the missing-`share/gk/kits` standalone-binary failure before `gk init` dies) and PATH-shadow warning (another `gk` earlier in `$PATH`).
13. **`ci:local` == CI** — append `check:parity` + manifest drift guard (`gen-cli-manifest.ts && git diff --exit-code cli-manifest.json`); fix the false CONTRIBUTING.md promise; align README `eval:memory` wording.
14. **Perf harness** — `scripts/perf-runtime.ts` (synthetic stores 50/200/1000/5000; times `expandedRecall`, `fingerprint`, end-to-end CLI recall; prints table) wired as `bun run perf`.
15. **Junk files** — `git rm 'src/compiler/validate.ts:84-93' 'src/compiler/validate.ts:90'` (confirmed git-tracked paste-fragments).
16. **Docs/backlog** — README stale test count made durable (count dropped from badge/headline), CHANGELOG round-2 entries, `idea-backlog.md` updated (R5/R6/R7 done; deferred items recorded).

## Deferred (recorded in backlog, not this round)
- **R8** — offline rg-based fallback retriever inside `routeAndRetrieve` on `CBM_UNAVAILABLE` (L; the only thing that makes `gk graph ask` work without a local CBM build).
- `gk completions <shell>` from `CLI_COMMANDS` (M).
- `scripts/install.sh` one-liner (M).
- Persistent recall index `.recall-index.json` (M; real design needed — invalidation contract).
- `consolidate` double store-scan + `buildLinks` all-pairs cliques (periodic command, low impact).

## Constraints
- gk stays zero-model: never invokes a model, reads no API key.
- CBM dialect subset only: `(n:Label)` MATCH, `(n)-[r]->(m)`, DISTINCT, ORDER BY, LIMIT; filtering client-side.
- Error-code surface is a public contract: existing codes/messages byte-identical unless listed as a fix.
- All tests offline; no live CBM server anywhere in the suite.
- Existing passing tests must pass unchanged unless the test asserted the buggy behavior being fixed (list: touchMemory legacy-tags, README-status claim).
