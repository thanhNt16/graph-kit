# Improvement Round 1 — Efficiency, Quality, Productivity

**Date:** 2026-09-08 · **Status:** approved (auto-approved per request) · **Branch:** `improvement/efficiency-quality-round1`

Brainstormed via 6 parallel survey agents (performance, code quality, testing/CI, contributor DX,
product/UX, robustness). Evidence verified directly. Baseline at `main` (`67f6ab7`):

- `bun test` — **610 pass / 52 fail** (all 52 from `tests/unit/kit-skill-frontmatter.test.ts`,
  an orphaned-but-deliberate regression test; the failures are real: 52/57 shipped
  `kits/**/SKILL.md` files have unquoted `: ` in `description:` frontmatter → invalid YAML)
- `bun run lint` — **16 errors** (13 format errors in committed `docs/diagrams/*.json`, 3 from untracked files)
- `ajv` + `ajv-formats` in package.json are imported nowhere (zod migration leftover, −2.4 MB)
- `src/cbm/client.ts` `close()` waits a fixed 1 s for already-exited children (≈3 s of suite wall time)
- `src/cli/commands/memory.ts` `traceMemory`/`touchMemory` call `YAML.parse` unguarded → corrupt
  frontmatter crashes `gk memory trace|touch|recall` with a raw stack, violating the documented
  "malformed entries are dropped and counted" contract
- Only `template.ts` writes atomically; memory/ledger/evidence rewrite files with truncating `writeFileSync`
- Zero dynamic imports: `gk --version` pays for zod+yaml+dagre (dagre needed by one subcommand)
- No CONTRIBUTING.md, no `.bun-version` (CI pins 1.3.9, contributors unpinned), no pre-commit gate
- `release.yml` builds/publishes on every push to main without running tests
- `scripts/check-cli-parity.ts` is wired into nothing; manifest drift already happened once (`c4cdfdc`)
- `idea-backlog.md` is stale: R1–R3 shipped in `fae84c0` while the file says QUEUED; R4 partial, R5/R6-partial/R7 open

## Scope (this round)

### A. Green build (P0)
1. Quote/block-scalar the `description:` frontmatter in all broken `kits/**/SKILL.md` files; commit the regression test.
2. `biome format` the 13 `docs/diagrams/*.json` files.
3. `.gitignore`: add `.pi/` (agent-local host dir, same policy as `.claude/`) and `tests/unit/.tmp-resolver/`.

### B. Bug fixes (P0/P1)
4. `memory.ts`: wrap `YAML.parse` in `traceMemory`/`touchMemory` — skip + count malformed frontmatter,
   consistent with the reader contract; route the trace/touch/recall CLI paths through `fail()` so no raw stack escapes.
5. `client.ts`: `sawExit` flag set in the existing `exit` handler; `close()` resolves immediately when set;
   escalate to `SIGKILL` on the 1 s timeout fallback instead of resolving with a live child.
6. Shared `src/fs.ts` `atomicWrite()` (sibling temp file + rename, pattern from `template.ts:140-160`);
   use it for in-place rewrites in `memory.ts`, `memory/consolidate.ts`, `memory/links.ts`,
   `memory/ledger.ts` (`.active` creation becomes exclusive-create `wx`, preserving existing RUN_ACTIVE
   semantics without a new race), `evidence/store.ts`.

### C. Efficiency (P1)
7. `bun remove ajv ajv-formats`.
8. Lazy dynamic-import `dagre` inside `src/cli/svg.ts` so only `gk graph svg` pays for it.

### D. Contributor productivity (P1)
9. `CONTRIBUTING.md` (setup, bun pin, `bun run ci:local` as the pre-push gate, changelog convention,
   kit-frontmatter rule) + `.bun-version` (1.3.9, matching CI) + README "Development" section.
10. `check:parity` script; run `check-cli-parity` + `cli-manifest.json` drift guard (`git diff --exit-code`) in CI after build.
11. `release.yml` bundle job runs `bun run typecheck && bun test` before packaging.
12. `idea-backlog.md` header updated to reflect real R-item status.

### E. Features (P2, lean)
13. `gk doctor` — one-shot environment check: binary version, active target + kit freshness vs binary,
    `.graphkit/` state, memory dir readability, CBM bridge reachability (short timeout). Human output,
    `--json` flag, exit 1 only when a check fails. Registered in `src/index.ts`, unit-tested with temp dirs.
14. `--limit <n>` / `--depth <n>` flags on `gk graph search|ask|trace|query`, threaded through
    `src/cbm/route.ts` (defaults unchanged: limit 8, depth 3). Finishes the R4 remainder.

## Out of scope (deferred, listed in PR)
graph.ts decomposition / R7 collapse; R5 `TraceHop` file anchors (needs upstream CBM); R6 Cypher templates;
`GraphKitError` adoption across `src/memory/*`; `process.exit(1)` consolidation; coverage upload to CI;
kit parity manifest; fingerprint caching; `listSessionGraphs` metadata fast-path.

## Execution
Three parallel implementers with disjoint file ownership:
- **K (hygiene):** `kits/**/SKILL.md`, `docs/diagrams/*.json`, `.gitignore`
- **B (bug fixes + efficiency):** `src/fs.ts`*, `src/cli/commands/memory.ts`, `src/memory/*`, `src/evidence/store.ts`, `src/cbm/client.ts`, `src/cli/svg.ts` + new unit tests
- **F (features + DX):** `src/cli/commands/doctor.ts`*, `src/index.ts`, `src/cli/commands/graph.ts`, `src/cbm/route.ts`, `CONTRIBUTING.md`, `.bun-version`, `README.md`, `.github/workflows/*`, `idea-backlog.md` + new unit tests

Coordinator-only: `package.json`, `bun.lock`, `CHANGELOG.md`, regression-test commit, integration, verification (`bun run ci:local`), PR.

**Acceptance:** `bun run typecheck` ✓, `bun run lint` ✓ (0 errors), `bun run build` ✓,
`bun test` green (≥ 663 tests, 0 fail), `check-changelog` ✓, new tests cover every fix/feature above.
