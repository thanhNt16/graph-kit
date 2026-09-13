# Improvement round 5 — efficiency, quality, productivity (5-lens brainstorm synthesis)

## What this round is

Round 5 of the improvement cadence, run exactly like rounds 1–4: **five parallel sub-agent audits** (performance, correctness, DX/productivity, architecture, product-value) of the tree at `d7edbd4`, each with executed reproductions or measured numbers; synthesis into a [design spec](docs/superpowers/specs/2026-09-13-improvement-round-5-design.md) + [implementation plan](docs/superpowers/plans/2026-09-13-improvement-round-5.md); then staged execution with `ci:local` green at every commit.

**Stacked on round 4** (base branch contains rounds 1–4; merge after those PRs).

Gates at HEAD: `bun run ci:local` ✅ (typecheck, lint, **894 tests / 0 fail**, build, cbm:parity, eval:memory, changelog, parity, manifest drift).

---

## 🐛 Bug fixes (all failing-first, repro tests committed)

| # | Severity | Bug |
|---|----------|-----|
| 1 | **data-loss / security** | `metadata.name` joined raw into output paths by `compile`, `graph svg`, `evidence report --html` — `name: ../../x` escaped the project dir and silently overwrote files. One `safeGraphName` sanitizer now serves every derived path |
| 2 | **data-loss** | A graph name with a space (e.g. `My Graph`) produced run ids `readRunMeta`'s regex rejects → `gk run end` removed `.active`, **then** failed: run unindexable AND unresumable, permanently. Ids now slug; `endRun` claims via atomic rename and **restores the pointer on any failure**; a crashed end's stale claim self-heals |
| 3 | **data-loss** | `saveSessionGraph` was check-then-write — concurrent savers clobbered each other's session graph while holding success envelopes. Exclusive-create (`wx`) + suffix bump |
| 4 | **crash** | `gk memory consolidate` died with a raw EISDIR stack on a directory named `*.md`; also non-atomic `index.md`, and the last unenveloped command. Now: dirent-checked prune, atomicWrite, `CONSOLIDATE_ERROR` envelope |
| 5 | **wrong-output** | Consolidate's own suggestions (`status: proposed`) failed `MemoryFileSchema` — healthy stores reported `malformed: 1` and suggestions could never be recalled. New `RecallFileSchema` for the recall walk |
| 6 | **wrong-output** | `loadCriteria` CRLF-intolerant: Windows-checkout criteria files degraded to `kind: report` and leaked raw frontmatter into descriptions. Shares `splitFrontmatter` now |
| 7 | **wrong-output** | `gk evidence add /abs/path` manufactured `<cwd>/tmp/...` then reported the file missing. Absolute paths accepted |
| 8 | **envelope inconsistency** | Corrupt active session graph → raw `YAMLParseError` string; `loadActiveGraph` uses the shared `YAML_INVALID` wrap (file+line+hint) |
| 9 | **markup injection** | Node ids / agent names / graph names unescaped in generated SVG `<text>`/`<title>`. XML-escaped |
| 10 | **false-pass (found during the round)** | The `check:parity` gate probed the human surface — after the printFail flip, unknown-leaf failures print verdict lines its JSON parse can't see, i.e. the gate would have false-passed every leaf. Probes pass `--json` explicitly |
| 11 | docs | The README's own "Define a graph" example **failed `gk validate`** (missing `objective` ×2, undeclared evidence key) — every first-time user's first command failed. Fixed + guard test; error-codes duplicate rows deduped and the drift guard now fails on dupes |

## ✨ New features

- **`gk run plan`** — pre-flight execution plan: per-wave node × model-tier table (curator waves marked), worst-case dispatch projection (node loops × `max_rounds`, loop-group spans, advisor `max_calls`), fan-out honestly flagged as data-dependent. Exits 1 on invalid graphs → doubles as the execute path's Step-0 preflight
- **`gk gate --github-actions`** — `::error` annotation per blocked key (missing vs stale detail) for CI pipelines
- **`gk new --topology <t>`** — writes the starter `graph.yaml` alongside the kit; next-step hint updated (no more "go run `gk graph new` yourself")
- **`gk template list --topology <t>`** — rows carry the materialized topology; misses fail with `UNKNOWN_TOPOLOGY` + canonical list
- **Full topology gallery** — 7 new curated templates (classify-and-act, adversarial-verification, generate-and-filter, memory-augmented, sdd, superpowers, research-and-build). "11 topologies" previously shipped 4 materializable examples. Gallery-coverage test materializes every bundled template + asserts per-topology coverage (rot guard)
- **`examples/review-diamond.yaml` + `examples/README.md`** — a runnable example that validates as-shipped, with the expected transcript

## ⚡ Performance & productivity

- **Central `printFail`** — the deferred "central fail renderer" narrow slice: 39 `console.log(JSON.stringify(fail(...)))` sites codemodded; **human mode gets `✗ CODE — message` verdicts** with findings/hints/available-lists rendered (the round-4 human-defaults pass left every catch block printing raw JSON); `--json` byte-identical. **61 redundant `process.exit(1)` calls deleted** (fail() already sets exitCode; also removes >64KB stdout truncation risk under pipes)
- **`check:parity` parallelized**: 2.23s → 0.58s of `ci:local` wall (8-way concurrency)
- **`graph.ts` (697 lines, 13 branches) → `graph/` package**: route table (keys asserted vs registry), `cbm.ts` (one CBM action path), `lifecycle.ts`, `render.ts`; the 136-line curator-interleave planner extracted as pure `planExecutionWaves` (now directly unit-tested); `src/cbm/seam.ts` = one DI seam + client lifecycle for graph+memory (was 2 copies); `kitSourceDir`/`templatesDir` → `targets/kit-source.ts` (last cross-command import killed); `groupUsage`/`argAt` helpers; 7 module-internal helpers un-exported
- Test harness: `runAsync` resolves on stubbed exit (cli-trust's 500ms settle burn gone)

## 📚 Docs & kit parity (agent-facing correctness)

- pi's `loops:`/`gate_evidence` **loop-group section ported to claude/cursor/opencode/codex** — README-documented flagship semantics existed in exactly one kit
- 4 laggard gk-recall skills stopped teaching the **removed `as_of` argument**
- **gk-status skills rewritten** (5 kits): call `gk status`/`gk run list` instead of hand-parsing `.graphkit/runs/.active` (the sidecar-first bug class round 3 fixed in the CLI); wrong creation hint fixed
- `gk run list` surfaced as the resume discovery front door; memory-curator agents document required `id:`/RFC3339 format + `gk memory list/show`
- `gk memory recall/list` human mode prints "N file(s) skipped as malformed" — silent drops were indistinguishable from "no match"
- README CLI reference regenerated (run plan, memory list/show, evidence, completions, gate rows); stale `GK_VERSION=v0.3.8` pin removed; CHANGELOG [Unreleased] collapsed from 5 scattered duplicate sections into one Added/Changed/Fixed

## 🔬 Honest deferrals (documented in the design addendum + backlog)

- **Lazy command dispatch** — re-measured during implementation: app-side startup floor is ~27ms here, and bench-relevant commands import zod+yaml through their own trees anyway; the 16-module rewrite buys ~20ms only for light commands. Re-deferred with numbers instead of landed for show
- **fails→stderr** — now a one-line flip inside `printFail` when a consumer asks (kept: stdout envelopes are the documented kit contract)
- `memory list --stats`, `gate --junit`, zod hand-map, single-source kit skill bodies — speculative/L-effort, recorded in the backlog

## Test stats

**894 tests** (was 858), **+36**: hostile-name lifecycle/containment, multiprocess save race, endRun pointer restore, consolidate/suggestions/criteria/evidence/YAML_INVALID/svg escaping, planner cadence unit tests, route-table shape, run plan, gallery coverage, README accuracy, gate annotations. Suite wall: 10.4s.

**Perf** (`bun run perf`, informational): recall n=50 63.7→60.7ms, n=5000 242.6→230.1ms; `check:parity` 2.23s→0.58s; `--version` ~50ms (floor ~27ms app-side; see deferral note).

---

## Commits (11)

1. `f373c52` docs(plan): round-5 design + implementation plan
2. `3a30872` fix: graph-name safety end-to-end
3. `3348dd5` fix: round-5 correctness batch
4. `58f6493` refactor: central printFail
5. `afc1add` refactor: graph/ package — route table, planner, CBM seam
6. `ce4ed3a` refactor: group helpers, kit-source relocation, un-exports
7. `c16064a` test(harness): early-exit resolution
8. `f58ca39` perf(ci): concurrent check:parity
9. `0cdbf95` feat: run plan, gallery, examples, gate annotations
10. `a6a3314` docs+feat(kits): kit parity round
11. `e4948d7` docs: round-5 changelog, backlog, design addendum
