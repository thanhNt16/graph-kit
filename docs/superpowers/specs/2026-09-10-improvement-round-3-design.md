# Improvement Round 3 — Design

**Date:** 2026-09-10 · **Branch:** `improvement/efficiency-quality-round3` (stacked on round-2 PR #4)
**Input:** 5-lens parallel brainstorm (runtime efficiency, code quality, test quality, DX, product robustness). Baseline: 734 tests pass, `ci:local` green at `e95bd3b`, coverage 94.1% funcs / 93.1% lines.

## Problem

Rounds 1–2 hardened the build, CLI surface, and graph-answer accuracy. The round-3 brainstorm surfaced a
residual class the earlier rounds did not cover: **honesty bugs** (paths where gk answers confidently but
wrongly or misleadingly — `ask` swallowing a dead bridge as "zero hits", linked recall resurfacing expired
memories, `status` reading an agent-authored sidecar instead of the ledger), plus measured algorithmic
waste left in the memory path, an error contract that is still ~80% migrated, and first-5-minutes DX
rough edges (a BLOCK verdict printed as a JSON hash wall, unknown commands dumping help silently,
onboarding hints naming commands that do not exist).

## Scope — 28 items, 5 workstreams

### Workstream A — honesty/correctness bugs

1. **Honest `CBM_UNAVAILABLE` in `ask`/`query --template`** — `route.ts` (3 catch sites) and
   `templates.ts` (4) swallow *every* rejection, including the fatal bridge-down error, so
   `gk graph ask` prints `ok` with empty results when the bridge is dead — indistinguishable from a real
   empty index. Export a typed `CbmUnavailableError` (or `isCbmUnavailable` predicate) from
   `client.ts`; rethrow it at all 7 catch sites. Healthy-bridge behavior unchanged. Regression:
   `CBM_CMD=/bin/false gk graph ask …` → fail envelope + exit 1.
2. **Linked recall hits bypass validity/supersede filters** — `recall-expanded.ts` pulls link neighbors
   from the *unfiltered* doc list, so `gk memory recall` can surface — and then reinforce — an expired or
   superseded memory. Filter neighbors through the same predicates. Also: add `malformed` to the CLI
   recall envelope (the gk-recall skill promises it; today only `recallWithStats` has it), and fix or drop
   the skill's `as_of` claim (nothing parses it — drop the claim, keep `as_of` threading in
   `applyRecallFilters` for the eval path).
3. **Evidence-key containment** — `addEvidence` joins `opts.key` straight into paths and never
   basename-checks; node-declared evidence keys are never validated at all (`validate.ts` guards only
   `evidence.required_keys`), and `gk evidence add` loads the graph without running `validateGraph`.
   Basename-check every key inside `addEvidence` (clean `GraphKitError`, traversal-style keys rejected)
   and mirror the rule over node evidence in `validateGraph`.
4. **`gk status` reads the ledger, not the sidecar** — status.ts hand-rolls `.active` resolution and
   treats `runs/current.json` (written only by kit instructions/agents, never by `gk`) as the primary
   metadata source, so a real `gk run start` run shows `name: "unknown"`, `round: -`. Use
   `activeRun()`/`readRunMeta()` from ledger.ts for id/name/started_at; keep `current.json` only for
   agent state (`round`, constraints), falling back to trace-derived round like `run.ts` does. Tests that
   seed the sidecar keep working (agent state still wins for round).
5. **Decay pass sees the whole store** — `traceMemory` scans root-only with a private readdir, so
   `patterns/` and `suggestions/` never decay (the code comment two functions away says they must).
   Switch to `walkMemoryStore`. Count semantics: `total`/`expired` now include subfolder entries; pinned
   counts in tests updated deliberately.
6. **route lexicon fixes** — `implementation` stems to `"implemente"` (non-word, BM25 miss); the
   `dataflow` rule shadows `wheredef` for "how do I find where X is defined". Restrict the `-ation→e`
   rule to verb-forming cases (small allowlist map), order `wheredef` before `dataflow`. Re-run the
   frozen route tests + `eval:memory` fixture run.
7. **Resume/trace shape validation** — `readJsonl` blind-casts; a parseable-but-wrong trace line
   (`{"node":"a","status":"ok"}`, no `evidence`) crashes reconciliation into an opaque
   `RUN_ERROR: TypeError`. Validate trace lines at the read boundary (skip-and-count invalid lines,
   surface `skipped_trace_lines`), wrap `meta.json` reads in `RUN_META_CORRUPT`.
8. **`atomicWrite` failure envelope** — the initial `writeFileSync` sits outside the try: ENOSPC/EACCES
   escapes as a raw errno and strands `${file}.${pid}.tmp`. Move it inside, best-effort unlink on
   failure, throw `GraphKitError("WRITE_FAILED", …)` with errno in details.
9. **Pointer/ledger races** — `endRun` TOCTOU can double-append to `index.jsonl` (two concurrent ends
   both pass `activeRun()`); the session-graph `.active` pointer uses plain `writeFileSync` (violates the
   fs.ts F6 contract; the runs pointer got the O_EXCL treatment, this one didn't). Re-check run identity
   after append (fail the loser), migrate the store pointer to `atomicWrite`, plus: `store/index.ts`
   active-pointer corruption yields a defined error, not silent garbage.

### Workstream B — error-contract & parsing unification

10. **Shared `splitFrontmatter`** — the `/^---\n([\s\S]*?)\n---/` regex is copy-pasted 4×
    (frontmatter.ts, inventory.ts, validate.ts criteria check, evidence/marker.ts) with divergent
    malformed behavior and CRLF blindness (a CRLF-authored memory file is silently dropped — the store
    becomes a no-op on Windows checkouts). Export one CRLF-tolerant `splitFrontmatter`, re-point all four,
    wrap the validate.ts criteria `YAML.parse` in try/catch (currently a corrupt `criteria/<id>.md`
    crashes `gk validate`). CRLF regression tests.
11. **Finish the GraphKitError migration** — `inventory.ts` `runInventory` throws raw `Error` for bad
    target (while the CLI action has a parallel `BAD_TARGET` path); `template.schema.ts` `resolveValue`
    throws raw (re-wrapped as `PARAM_INVALID` upstream); `client.ts` raw errors force two callers to
    string-sniff the CBM package name; template name-regex message hard-coded 3×. Typed errors at the
    source, one `toCbmFailure` classifier, one message built from `TEMPLATE_NAME_RE.source`. Existing
    codes/messages byte-identical unless listed as a fix.
12. **`loadGraph` reuse** — `run.ts` (advisor lookup) and `resume.ts` (`parseGraph`) hand-roll
    read+parse+safeParse; a syntactically broken graph.yaml surfaces as misleading `BAD_ADVISOR`.
    Route through `loadGraph` (codes become `GRAPH_FILE_NOT_FOUND`/`SCHEMA_INVALID`; pinned tests
    updated).
13. **Delete legacy casts in `validate.ts`** — 4 `as any` sites for fields the zod schema already types
    (`role`, `eval`, `topology_config`). Pure typing.
14. **`reinforceEntry` dedup** — `touchMemory`/`touchMemoryByPath` carry identical reinforcement bodies
    (bump `use_count`, set `last_used_at`, atomic rewrite) already drifting (id-guard mismatch); three
    `as unknown as` casts exist only to mutate zod output. One helper, one cast.

### Workstream C — memory/consolidate perf

15. **`expandedRecall` link expansion O(1)** — `docs.find` per neighbor is O(hits·deg·n); build the
    id→doc Map the function already almost has. Invisible in the current perf table (the synthetic store
    has no `.links.json`) — pure lookup equivalence.
16. **`buildLinks` quadratic copy + file bloat** — entity lists built with `[...(get() ?? []), id]`
    copies per insert (O(m²) per entity); `.links.json` pretty-printed and re-parsed on every recall.
    Push instead of spread; compact JSON write. (Readers are indifferent; `.links.json` is
    rebuildable-by-contract.)
17. **`consolidate` single-pass** — consolidate rewrites every pattern/suggestion via `atomicWrite`
    (mtime churn even when bytes are identical), then prune re-reads them, then `buildLinks` re-walks
    and re-parses the entire store. Skip-identical writes in `writeEntry`; let `buildLinks` accept
    pre-parsed entries so consolidate's own writes aren't re-parsed. Dismissal-merge path untouched.
18. **Perf harness measures real shapes** — synthetic stores lack `.links.json`/`use_count`, so link
    expansion and the two fixes above are unmeasured; no startup-floor row explains the ~40 ms flat CLI
    overhead. Generate links (synthesize + `buildLinks`), add a consolidate ms/op column and a
    `node dist/index.js --version` startup row, bump iterations for stability. Still informational.

**Deferred (recorded in backlog, not this round):** persistent recall index `.recall-index.json` (L —
stat-keyed invalidation contract is designed in the brainstorm notes, but it changes recall's data path
and deserves its own round), lazy action bodies + `--splitting` bundle (M-L, parity-gate risk), R8 offline
ripgrep fallback retriever (L — full mini-design already in brainstorm notes; item 1 is its phase 0),
E1–E5 memory-hygiene clamps (M), coverage-floor gate.

### Workstream D — CLI DX

19. **`gk gate` BLOCK prints the verdict table** — `renderGate()` exists but is bypassed when
    `verdict !== "MERGE"`, so the most common operator failure prints a JSON sha256 wall. Human mode:
    `VERDICT: BLOCK` table + `Missing: <keys> — produce <dir>/<key>.md, then rerun gk gate`, exit 1.
    `--json` keeps the full machine envelope (documented contract change for human mode only; CHANGELOG
    entry).
20. **Unknown command / flag get clean one-liners** — `gk frobnicate` silently dumps full help (no
    "unknown command"); `gk graph --badflag` prints a raw `CACError` stack. Wrap `cli.parse()`, print
    `Unknown option --badflag — run 'gk graph --help'`; in the unmatched-command branch print
    `Unknown command "x"` + closest match by edit distance over `CLI_COMMANDS` paths. Group
    `UNKNOWN_*` JSON envelopes untouched.
21. **Remediation strings tell the truth** — `graph list` empty-state hint says `gk init-graph` (not a
    CLI command); `init`/`new` success line says `/gk:status` (wrong on pi); `graph new` missing-arg
    error leads with a bare `UNKNOWN_TOPOLOGY`; `memory recall` can't distinguish "no store yet" from
    "no match"; `inventory --help` prints "(default: claude)" twice. Fix strings; add a unit test that
    every backticked `gk …` hint in output strings resolves against `CLI_COMMANDS`.
22. **Group `--help` lists subcommands** — `gk graph --help` shows less than bare `gk graph`
    (subcommand list only exists in the bare path). Give the 6 groups the same subcommand help text in
    both paths.
23. **`scripts/install.sh` one-liner** — README install is a 5-line curl|tar ritual whose `rm -rf
    ~/.local/bin/share` step deletes an unrelated dir if pointed elsewhere. Idempotent script:
    os/arch detect, temp-extract-then-swap (no blanket rm), PATH check printing the exact export line,
    `gk --version` + `gk doctor` finisher; README Install shrinks to the one-liner + manual fallback.
    No sudo by default.
24. **Docs polish** — `docs/error-codes.md` catalog (code → meaning → remediation; generated from a
    central table in `src/errors.ts` so it can't drift), README: delete the stray empty `## Boundary`
    heading, stop hardcoding the version in the help copy, link the catalog.

### Workstream E — tests, gates, docs hygiene

25. **`gk memory` CLI error envelopes tested** — the catch blocks (`MEMORY_TRACE_FAILED`,
    `MEMORY_TOUCH_FAILED`, `MEMORY_NOT_FOUND`, `UNKNOWN_MEMORY_SUBCOMMAND`, recall `MEMORY_DIR_UNREADABLE`)
    have zero assertions; the "corrupt store must exit via the JSON contract" promise is unenforced.
    Corrupt-YAML store → fail envelope + exit 1; unknown touch id; unknown subcommand with available list.
26. **Wire `eval:memory` into `ci:local`** — the recall-quality eval is deterministic, offline, and fails
    loudly, but is manual-only, while `cbm:parity` (also in the gate) is a guaranteed-SKIP no-op.
    Append `eval:memory` to the gate; fix `cbm-parity-gate.test.ts` to execute the SKIP path instead of
    string-matching package.json; README/CONTRIBUTING wording.
27. **Test-artifact + harness hygiene** — `tests/unit/.tmp-resolver/*` stubs are git-tracked while
    `.gitignore` ignores the dir (dirty-tree flakes); 17 test files hand-roll the same cac harness.
    Untrack the dir; add `tests/helpers/cli-harness.ts` (cac instance + stdout sink + exit/log stubbing +
    auto-reset) and migrate the worst offenders opportunistically (resolver, memory error envelopes —
    new tests use it from day one).
28. **CBM wire-shape coverage** — `src/cbm/index.ts` is 0% (the seam swallows `indexProject` in every
    test): assert the JSON-RPC `params` shape with a recording stub; one `ask` test where the fake
    `get_code_snippet` returns source, asserting snippets surface. Plus template `SOURCE_INVALID`
    CLI-path tests (malformed YAML through `template from-source`).

## Constraints

- gk stays zero-model: never invokes a model, reads no API key; all tests offline.
- Error-code surface is a public contract: existing codes/messages byte-identical unless listed as a fix
  (fixes: new `RUN_META_CORRUPT`, `WRITE_FAILED` envelope on write failure, `EVIDENCE_KEY_INVALID` for
  traversal keys, run/resume `BAD_ADVISOR`→`GRAPH_FILE_NOT_FOUND`/`SCHEMA_INVALID` on broken graph.yaml,
  human-mode `gate` BLOCK output).
- `bun run ci:local` remains THE gate and must pass; `eval:memory` joins it (it must stay deterministic).
- Existing passing tests change only where they pinned the buggy behavior (list: linked-recall filtering,
  traceMemory counts, status metadata source, BLOCK human output, run/resume graph-error codes,
  template shadowed asymmetry, stale remediation strings).
