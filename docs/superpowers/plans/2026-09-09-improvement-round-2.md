# Improvement Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship backlog R5/R6/R7 (graph-answer accuracy) plus the quality/perf/DX fixes surfaced by the 4-lens brainstorm, with zero regressions across the 678-test suite.

**Architecture:** Three parallel workstreams with disjoint file ownership — A: `src/cli/commands/graph.ts` + `src/cbm/*` + render path; B: `src/memory/*` + `src/eval/memory-recall.ts` + `src/cli/commands/{memory,run}.ts`; C: `src/evidence/*` + `src/cli/commands/{gate,status,doctor,kit,inventory}.ts` + infra files. No file is edited by two workstreams. Commits happen at integration, not per workstream.

**Tech Stack:** Bun, TypeScript (strict), zod v4, cac, biome. Test runner: `bun test`.

## Global Constraints
- Zero-model runtime: gk never invokes a model or reads an API key.
- CBM Cypher subset only: `(n:Label)` MATCH, `(n)-[r]->(m)`, DISTINCT, ORDER BY, LIMIT. All other filtering is client-side TS.
- Error codes/messages are a public contract: byte-identical unless the plan lists the change.
- All tests offline (fake CBM clients / `_setCbmSeam` harness / temp dirs). No live server.
- `bun run lint` (biome) must pass; run `bunx biome check --write <files>` after editing.
- Workstreams must NOT run `git commit` — integration commits happen in the lead session.

---

## Workstream A — graph/CBM accuracy (tasks A1-A5)

### Task A1: Move `graphTemplate` to `src/cli/graph-templates.ts`
**Files:** Create `src/cli/graph-templates.ts`; Modify `src/cli/commands/graph.ts` (delete lines ~106-621, import instead).
- [ ] Cut `graphTemplate()` verbatim (pure data, no imports) into the new file; `export function graphTemplate(...)`.
- [ ] `graph.ts` imports it. Verify: `bun test tests/unit/graph-commands.test.ts tests/unit/custom-topology.test.ts tests/unit/template-commands.test.ts` all pass.

### Task A2 (R7): Single CBM dispatch path
**Files:** Modify `src/cli/commands/graph.ts` (~1034-1145); Test `tests/unit/graph-cbm-commands.test.ts` (extend, don't change existing cases).
**Interfaces:** `const CBM_ACTIONS: Record<string, CbmAction>` where `CbmAction = { missingArg?: { value: (pos: string[]) => string | undefined; message: string }; usesLimit?: boolean; usesDepth?: boolean; run: (c: CbmClient, pos: string[], flags: { limit?: number; depth?: number; template?: string }) => Promise<unknown> }`.
- [ ] One shared runner does: flag validation (`INVALID_LIMIT`/`INVALID_DEPTH`, message embeds `JSON.stringify(opts[flag])`, ask validates limit before depth), `MISSING_ARG`, `--templates` offline list, `cbmCall` close-on-throw, single catch → `cbmFailure`.
- [ ] Acceptance bar: every existing test in `tests/unit/graph-cbm-commands.test.ts` passes **unchanged**.
- [ ] Add CLI-level tests: `--limit 0` / `--depth -1` on search, ask, trace → fail envelope with exact code; happy-path `--limit 2 --depth 2` threads values (assert via captured call args).

### Task A3 (R6): Query templates
**Files:** Create `src/cbm/templates.ts`; Modify `src/cbm/route.ts` (delegate deadcode branch), `src/cli/commands/graph.ts` (query branch + group options), `src/cli/command-registry.ts` (+manifest regen), `kits/claude/agents/code-reviewer.md`, `kits/claude/agents/data-engineer.md`; Test `tests/unit/cbm-templates.test.ts` (new), `tests/unit/route.test.ts`, `tests/unit/graph-cbm-commands.test.ts`.
**Interfaces:**
```ts
export interface QueryTemplate {
  description: string;
  argHint?: string; // undefined = zero-arg
  run(client: CbmClient, arg: string | undefined, project: string | undefined, limit: number): Promise<unknown>;
}
export const QUERY_TEMPLATES: Record<string, QueryTemplate>; // dead-code | callers-of | symbol-set
export async function runTemplate(client: CbmClient, name: string, arg: string | undefined, project: string | undefined, limit: number): Promise<unknown>; // throws GraphKitError("UNKNOWN_TEMPLATE", ..., { available })
export function listTemplates(): Array<{ name: string; description: string; arg_hint?: string }>;
```
- [ ] Move route.ts:203-230 dead-code anti-join **verbatim** into `dead-code.run` (same `isolated: {name, file, line}[]`, same even sort, cap `limit` default 25). `routeAndRetrieve`'s deadcode branch calls `runTemplate(client, "dead-code", ...)` — `route.test.ts` must stay green with zero edits.
- [ ] `callers-of <symbol>`: `MATCH (m)-[r]->(n) RETURN DISTINCT m.name, m.file_path, n.name, n.start_line LIMIT 500`, client-side `n.name === arg` filter, shape `{symbol, callers: [{name, file, line}]}`.
- [ ] `symbol-set <file-path>`: one wide `MATCH (n) RETURN n.name, n.file_path, n.label, n.start_line LIMIT 2000`, client-side partition → `{file, declared, referencing_files, unreferenced}`.
- [ ] CLI: `.option("--template <name>")` + `.option("--templates")` on the graph group; `--templates` lists and exits 0 **before any client is created** (assert client factory never invoked); `--template` uses `args[0]` as template arg (when `argHint`), `args[1]` = project, threads `--limit`; unknown name → `fail("UNKNOWN_TEMPLATE", ...)` with `available` — no CBM call. Raw Cypher passthrough unchanged when no flag.
- [ ] Add both options to `command-registry.ts` `graph query` entry; regen manifest: `bun run scripts/gen-cli-manifest.ts`.
- [ ] Kit docs: one line each in code-reviewer.md + data-engineer.md: prefer `gk graph ask` (routed); use `gk graph query --template dead-code` for "declared but never used".
- [ ] Tests: fake client canned `QueryResult`s — anti-join excludes linked vars + non-source files, sort/cap preserved; `--template dead-code` → ok envelope + `capturedTool === "query_graph"`; `--templates` never invokes factory; `UNKNOWN_TEMPLATE` fail; CBM throw → `CBM_UNAVAILABLE` (reuse `cbmFailure`).

### Task A4 (R5): TraceHop coordinates + hop() fallback fix
**Files:** Modify `src/cbm/contract.ts` (TraceHop += `file_path?: string; start_line?: number; end_line?: number`), `src/cbm/route.ts` (hop + RoutedResult callers/callees `line?`); Test `tests/unit/cbm-contract.test.ts`, `tests/unit/route.test.ts`, `tests/unit/graph-cbm-commands.test.ts`.
- [ ] `hop()` becomes: server coords verbatim when present; else `pickCandidate(deriveFiles(qn), qn)` — return the **full** candidate list tail when the last segment matches `/^[a-z0-9_-]+$/` (file/dir node: `proj.src.cli.commands.graph` → `src/cli/commands/graph.ts`), else the parent (function tail). Add `line: x.start_line` when present.
- [ ] Tests: literal-with-fields contract case; server `file_path`/`start_line` used verbatim; both fallback bug classes (`proj.src.cli.commands.graph` → graph.ts, `proj.src.index` → `src/index.ts`); trace CLI pass-through of hop coords.

### Task A5: Typed render path
**Files:** Create `src/compiler/loader.ts` (move `loadGraph`, `resolveBareValidateGraph`); Modify `src/cli/commands/graph.ts` (import + re-export), `src/cli/svg.ts` (`renderSvg(graph: Graph)`, kill 4× `as any` at :31,36,47,63; delete its internal unvalidated parse), `src/cli/ascii.ts` (delete hand-rolled `GraphNode`/`Graph`, take zod `Graph`); Test: existing `graph-subcommand-regression.test.ts`, `graph-commands.test.ts`, `skills-template-viewer.test.ts` must pass unchanged.
- [ ] Keep `export { loadGraph }` (and `resolveBareValidateGraph`) re-exports from `graph.ts` for any test importing them — grep tests first.
- [ ] svg/ascii branches of `graph.ts` call `loadGraph` once and pass the typed object.

## Workstream B — memory/ledger (tasks B1-B4)

### Task B1: Frontmatter helper + touchMemory bug fix
**Files:** Create `src/memory/frontmatter.ts`; Modify `src/cli/commands/memory.ts` (traceMemory :104-135, touchMemory :213-234, walker :203-211), `src/eval/memory-recall.ts` (readMemories :92-105), `src/memory/suggest.ts` (:24-38, :55-62), `src/memory/links.ts` (collect :46-63), `src/memory/recall-expanded.ts` (:29-36); Test: existing memory tests must pass; add `tests/unit/memory-frontmatter.test.ts`.
**Interfaces:**
```ts
export function parseMemoryFile(raw: string, fallbackId: string): { fm: MemoryFile; body: string } | null;
// legacy string tags coerced to array; id/type defaults; MemoryFileSchema.safeParse; null on malformed
export function walkMemoryStore(memDir: string, opts?: { skip?: string[] }): Array<{ id: string; file: string; raw: string; fm: MemoryFile; body: string }>;
// root + one sublevel, skip dot-dirs; opts.skip = extra filenames (e.g. index.md/log.md)
```
- [ ] Preserve per-call-site exclusions: traceMemory/readMemories skip `index.md`/`log.md`; touchMemory does not.
- [ ] **Bug fix (test it):** `touchMemory` now coerces legacy `tags: "foo"` like `traceMemory` — a reinforcement on a legacy entry no longer returns null. Add regression test.

### Task B2: Reinforcement by path (O(k))
**Files:** Modify `src/memory/recall-expanded.ts` (hits carry `path` from the `where` map), `src/cli/commands/memory.ts` (new `touchMemoryByPath(cwd, path, id)`; recall loop :331-341 uses it); Test `tests/unit/recall-expanded.test.ts`, `tests/unit/memory-recall.test.ts`.
- [ ] `touchMemoryByPath` reads exactly the one file, validates, rewrites via `atomicWrite`. Keep `touchMemory` for standalone `gk memory touch`.
- [ ] Test: recall with k hits issues exactly k single-file touches (spy/counter on fs or on the helper).

### Task B3: GraphKitError unification + readJsonl
**Files:** Modify `src/memory/ledger.ts` (:99,123,125,175,200,253,307 + readAdvisorEvents/readTrace/readRunIndex :206-249), `src/memory/resume.ts` (12 sites), `src/memory/consolidate.ts` (:140,182), `src/cli/commands/run.ts` (errCode :20-24 → instanceof check; thread `e.details` into `fail()` at :146); Test: `run-ledger.test.ts`, `run-resume.test.ts`, `run-cli.test.ts` must pass with byte-identical messages.
- [ ] `new GraphKitError("RUN_ACTIVE", "run already active at ...")` etc. — message text unchanged so `/RUN_ACTIVE: run already active at .../` toThrow matchers still pass.
- [ ] `function readJsonl<T>(file: string): T[]` — split/parse/skip-torn-line, shared by the three readers.

### Task B4: resolveSuperseded Set dedup
**Files:** Modify `src/eval/memory-recall.ts` (:33, :47); Test: existing eval:memory + `tests/unit/memory-recall.test.ts` unchanged-green.
- [ ] Carry `Set<string>` of pushed ids + successor ids beside `out`; drop the `Array.some`/`Array.includes` scans. Behavior-identical.

## Workstream C — evidence/DX/infra (tasks C1-C5)

### Task C1: Fingerprint single-spawn
**Files:** Modify `src/evidence/fingerprint.ts` (:26-29); Test `tests/unit/fingerprint.test.ts` (add equivalence case).
- [ ] `git --no-optional-locks ls-files -mo --exclude-standard -z` (one spawn) + `rev-parse HEAD`; keep sort+dedup (:33) and the 1 MiB hashing cap. Test: combined listing ≡ previous two-call union on a temp repo with modified + untracked files.

### Task C2: Human renderers + functional `--json` on gate/status/inventory/run status/memory recall/init/new
**Files:** Modify `src/cli/commands/gate.ts` (:95-103), `status.ts` (:21,45), `inventory.ts` (:313), `src/cli/commands/run.ts` is Workstream B's — **the run-status renderer goes to Workstream B**; kit.ts (:228,252) and memory recall renderer go to B as well. C owns gate/status/inventory/kit init-new only. Test: extend `tests/unit/cli-status-commands.test.ts`, `cli-e2e-commands.test.ts`.
- [ ] Pattern to copy: doctor's `renderDoctor()` + `opts.json` branch (doctor.ts:146-167); padded table style from `graph list` (graph.ts:735-746).
- [ ] Gate default: `VERDICT: PASS|BLOCK` line + per-key `key  ok/stale  fresh/stale` table; sha256 manifest **only** under `--json`. Status default: human summary (run, round, coverage, verdict); `--json` = today's envelope. Init/new: `installed 24 entries into .claude/ (target claude) — run /gk:status in your agent` style line; `--json` = envelope.
- [ ] Fail envelopes stay JSON-on-stdout (unchanged). Every command: default success output is non-JSON and contains the key fields; `--json` parses as `{status, data}`.

### Task C3: Doctor kit-source + PATH-shadow checks
**Files:** Modify `src/cli/commands/doctor.ts` (+checks 6/7 before the summary); Test `tests/unit/doctor.test.ts`.
- [ ] Check 6 "kit source": call `kitSourceDir()` per detected target; `GraphKitError` → fail with the existing `KIT_SOURCE_MISSING` hint. Check 7 "PATH shadow": walk `$PATH` for other `gk` executables preceding `process.execPath` → warn (not fail). Both deterministic/offline per the doctor contract.

### Task C4: `ci:local` == CI + docs truth
**Files:** Modify `package.json` (ci:local), `CONTRIBUTING.md` (:25 table, :33), `README.md` (Development section + `eval:memory` wording at :49).
- [ ] `"ci:local": "bun run typecheck && bun run lint && bun run build && bun test && bun run cbm:parity && bun run check-changelog && bun run check:parity && bun run scripts/gen-cli-manifest.ts && git diff --exit-code cli-manifest.json"`.
- [ ] README: `eval:memory` described as a deterministic check must either be wired into a gate or reworded — reword (it stays a manual eval).

### Task C5: Perf harness + junk files
**Files:** Create `scripts/perf-runtime.ts`; Modify `package.json` (`"perf": "bun run scripts/perf-runtime.ts"`); `git rm 'src/compiler/validate.ts:84-93' 'src/compiler/validate.ts:90'`.
- [ ] Harness: generate size-tiered synthetic stores (50/200/1000/5000) in a temp dir, time `expandedRecall`, `fingerprint`, end-to-end `node dist/index.js memory recall` (build first if dist missing → skip CLI timing with a note), print a table. No thresholds, no CI wiring.

## Integration (lead session, after A+B+C)
- [ ] `bun run ci:local` green (now including parity + drift gates); `bun run perf` runs; `bun run eval:memory` hit_rate unchanged.
- [ ] README: drop brittle test count from badge + headline; update any changed output examples.
- [ ] CHANGELOG [Unreleased]: round-2 Added/Fixed/Changed entries.
- [ ] `idea-backlog.md`: R5/R6/R7 → done; record deferred R8/completions/install.sh/recall-index.
- [ ] Commits (logical groups), push, PR stacked on `improvement/efficiency-quality-round1`.
