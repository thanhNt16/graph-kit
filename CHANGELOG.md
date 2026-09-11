# Changelog

All notable changes to GraphKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]
### Added
- **`gk run list`** — every run (ended from `index.jsonl`, plus dir-only `running`/`interrupted` runs), newest first, with resume hints; `gk run status <run-id>` renders any recorded run, not just the active one. The advertised `gk run resume <id>` finally has a discovery front door
- **`gk memory list` / `gk memory show <id>`** — store inspection (id, status, salience, use_count, file) and raw per-entry print; ids were previously undiscoverable
- **`gk completions [bash|zsh|fish]`** — static completion scripts generated from the command registry (new subcommands/flags become Tab-completable with no extra edit); covered by the manifest/parity gates
- **`memory trace --dry-run`** — previews the decay pass (`would-expire` per entry) with zero writes and no audit rows; `expire_policy` from graph.yaml `topology_config.memory` is now honored by the CLI (the schema field existed but never reached the decay pass)
- `--minify` on the bun build — dist 962KB → 551KB; `node dist/index.js --version` ~68ms → ~60ms
- CONTRIBUTING gained a repo map and an environment-variable reference table

### Changed
- `memory trace` reports entries with an unparseable `last_used_at` (`unparseable_dates`, action `unknown-date`) and never auto-expires them — an unknown score is no longer indistinguishable from a low score
- `gk status` computes evidence coverage against the ACTIVE RUN's recorded graph (`meta.graph_path`), so a resumed run's shrunk required keys no longer report a permanent BLOCK it could never clear
- `gk validate` success prints `validate: ok (topology …)` in human mode; `VALIDATION_FAILED` findings render as an indented human list in validate/compile/gate (`renderFindings`); `--json` envelopes unchanged
- Human defaults completed: `run start/node/end`, `memory consolidate`, `evidence report` (prints the markdown itself), and `gk template list` — now the README-promised table with the `origin` column
- `gk run start` / `run end` / `graph show` reuse shared paths: exclusive run-dir creation, O(1) session-graph lookup instead of parsing every session graph
- `ci:local` runs tests before the build (fail-fast); same steps otherwise

### Fixed
- **Silent memory expiry**: one loosely-written `last_used_at` ("recently", any string `Date.parse` rejects) mapped to age `Infinity` → score 0 → auto-expiry rewrite of a healthy memory. Unparseable dates and non-finite score inputs now yield an UNKNOWN score that never triggers expiry
- **Evidence marker corruption**: marker frontmatter values are YAML-serialized (notes containing `": "`, `#`, or newlines used to emit unparseable markers, silently degrading gate freshness to `unknown`); hostile-note round-trip tests pin it
- **Arbitrary file read**: `gk evidence report --html` embedded any marker-authored `artifact:` path — traversal, absolute paths, and in-dir symlinks are now contained to the evidence dir (realpath prefix check)
- **Run-dir TOCTOU**: two same-second `gk run start`s shared one dir and the loser clobbered the winner's meta/trace before dying on the `.active` claim; run dirs are now exclusive-created and claimed before populating, so a RUN_ACTIVE loser leaves no populated orphan
- **Resume path containment**: trace-authored evidence keys pass `isValidEvidenceKey` before any path join — invalid keys count as unsatisfied (node re-runs) instead of probing `../` paths or emitting them as derived-graph refs
- **CBM dead-bridge spawn**: unconfigured bridge (no `CBM_CMD`/`CBM_ARGS`) now fails fast with the honest `CBM_UNAVAILABLE` envelope instead of spawning `npx` into a guaranteed npm 404 (~800ms per graph/memory-index command); a wedged-but-alive bridge hits a per-call timeout (`CBM_TIMEOUT_MS`, default 60s) instead of hanging forever
- `gk template list` no longer bricks on one malformed `.gk.yaml` (per-entry skip + warning, like `graph list`); the usage text no longer lists the phantom `close` subcommand
- `gk models`: a corrupt overrides file is reported (`OVERRIDES_CORRUPT`) and `set` refuses to erase it without `--force`; overrides write atomically; lowercase `map` error code is now `MAP_INVALID`
- `gk init` writes `AGENTS.md` atomically; a kept `graphkit:start` with a deleted `graphkit:end` marker fails with `AGENTS_MD_UNCLOSED` + remediation instead of appending a duplicate section
- `gk memory touch` without an id → `MISSING_ARG`, not `No memory with id "undefined"`
- `buildLinks` skips entities shared by more than 50 entries — one ubiquitous entity used to add m(m-1)/2 edges (5.8s measured at n=5000); memory-path perf: frontmatter flat-scalar fast-path with YAML.parse fallback (recall/links ~2x at n=50, ~1.6x at n=5000)
- Docs drift: `MISSING_PARAMS` remediation now names the real `--params '<json>'` flag; README `eval:memory` wording matches its gate status

### Changed
- **`scripts/install.sh` one-liner** — platform-detecting, atomic-swap installer (`curl -fsSL …/install.sh | sh`); no sudo, no blanket `rm -rf` of the install dir, PATH check printing the exact export line. README Install leads with it (manual tarball kept as fallback)
- **`docs/error-codes.md`** — every fail-envelope code catalogued with meaning + remediation; `tests/unit/error-codes-doc.test.ts` fails when a code is used in src/ but missing from the catalog, or left stale in it
- Group `--help` lists subcommands with descriptions (`gk graph --help` now shows more than bare `gk graph`, not less)
- Unknown top-level commands get a one-line usage error with a did-you-mean suggestion (`gk memmory` → "did you mean `memory`?", edit distance over the command registry); mistyped flags print one clean line instead of a raw `CACError` stack
- `bun run ci:local` also runs `eval:memory` — the deterministic, offline recall-quality eval joins THE gate (`cbm:parity` stays; while the CBM package is unpublished it is a documented SKIP, and its skip path is now executed by a test instead of string-matched)
- Shared CLI test harness (`tests/helpers/cli-harness.ts`); the `tests/unit/.tmp-resolver` stub files are untracked (they were git-tracked while gitignored — dirty-tree flakes)
- **`gk graph query --template dead-code|callers-of <symbol>|symbol-set <file>`** (backlog R6) — pre-rolled graph queries for the question classes raw Cypher missed: dead-code uses only proven CBM Cypher constructs and does all filtering client-side; `--templates` lists them offline without touching the bridge; unknown names fail with `UNKNOWN_TEMPLATE` + available list. The dead-code anti-join is now single-source (`src/cbm/templates.ts`) — `routeAndRetrieve`'s deadcode branch delegates to it. Templates documented in the claude kit's code-reviewer/data-engineer agents
- **`TraceHop.file_path` / `start_line` / `end_line`** (backlog R5) — server-side coordinates surface verbatim in `gk graph trace`/`ask` payloads (caller/callee entries gain `line`). The client-side fallback no longer mis-derives file/dir-node hops (`proj.src.cli.commands.graph` → `src/cli/commands/graph.ts`, was `commands.ts`; `proj.src.index` → `src/index.ts`, was `src.ts`)
- `gk doctor` kit-source check (catches a standalone binary missing its `share/gk/kits` tree before `gk init` fails with `KIT_SOURCE_MISSING`) and PATH-shadow warning (another `gk` earlier in `$PATH`)
- `bun run perf` — runtime latency harness (`scripts/perf-runtime.ts`): synthetic memory stores (50/200/1000/5000), times recall, fingerprint, and end-to-end CLI recall
- `criteria/` registry + `evidence.criteria` id list + `evidence.freshness: report|strict` in graph.yaml; `criteria-keys`/`criteria-file` validation
- `gk evidence add` — content-addressed artifacts with provenance markers (`EVIDENCE_KEY_NOT_DECLARED` / `EVIDENCE_FILE_MISSING` / `EVIDENCE_TOO_LARGE`)
- Gate/status per-key freshness (`fresh|stale|unknown`); strict mode BLOCKs on stale required keys
- `gk evidence report` — criterion-first markdown + `--html` self-contained page (SVG never inlined, all content escaped)
- `gk run start` stamps the repo fingerprint into the run ledger
- Archify diagram suite (`docs/diagrams/`): system architecture, execution workflow, run-resume lifecycle, and all eleven topologies as standalone explorables (inline SVG, trace motion, dark/light). Gallery linked from the docs landing page.
- `gk doctor` — one-shot environment check (version, installed-kit freshness, `.graphkit/` state, graph.yaml validity, CBM bridge configuration); human output + `--json`, exit 1 only on failures
- `--limit <n>` / `--depth <n>` flags on `gk graph search|ask|trace|query` (defaults unchanged: 8 / 3), threaded through the CBM routing layer
- `CONTRIBUTING.md`, `.bun-version` (pins the CI bun 1.3.9), README "Development" section; `check:parity` script wired into CI with a `cli-manifest.json` drift guard

### Fixed
- **`gk graph ask` (and `query --template`) silently answered "ok, zero hits" when the CBM bridge was dead**: the fatal `CBM_UNAVAILABLE` rejection was swallowed at seven fail-open catch sites, printing an empty result indistinguishable from a real empty index. Fatal bridge failures now surface honestly (typed `CbmUnavailableError` rethrown by `route.ts`/`templates.ts`); per-query misses still fail open
- **Linked recall hits bypassed the validity/supersede filters**: `gk memory recall` could surface — and then reinforce — an expired or superseded memory pulled in via `.links.json` expansion. Neighbors now pass the same filters as direct hits; the JSON envelope reports a `malformed` count (as the gk-recall skill documents), and the skill no longer claims an `as_of` flag nothing parsed
- **Evidence keys are basename-validated at the write path**: a node-declared key like `../../evil` (never checked — validation guarded only `required_keys`, and `gk evidence add` loads the graph without validating) can no longer write outside the evidence dir (`EVIDENCE_KEY_INVALID`); `validateGraph` flags traversal keys on node evidence too
- **`gk status` reports the ledger's run id and started_at for real runs** — it treated the agent-authored `runs/current.json` sidecar as the primary source, so every `gk run start` run showed `name: "unknown"`, `round: -`. The sidecar still supplies round/constraints; round falls back to trace-derived (highest wave + 1, same as `gk run status`)
- **Decay never saw `patterns/` or `suggestions/`**: `gk memory trace` scanned the store root with a private readdir while every other reader walks subfolders — patterns could never age out and trace's `total` disagreed with recall's `scanned`. One walker now serves the whole store
- **Route lexicon fixes**: `implementation` stemmed to BM25-dead `implemente` (the `-ation → -e` rule mangled 17 common nouns, including `validation` → `valide`), and "how do I find where X is defined" routed to dataflow instead of where-defined — the more specific intent wins now
- **Resume boundary shape validation**: a parseable-but-wrong trace line (`{"node":"a","status":"ok"}`, no evidence array) crashed reconciliation into an opaque `RUN_ERROR: TypeError`; invalid and torn trace lines are now skipped and counted (`skipped_trace_lines`), and corrupt `meta.json` fails with `RUN_META_CORRUPT` instead of a raw SyntaxError
- `atomicWrite` cleaned its temp file only on rename failure — ENOSPC/EACCES during the write escaped as a raw errno and stranded a `.tmp` in the store; the write is inside the guarded section now and failures carry `WRITE_FAILED` with the errno in details
- Concurrent `gk run end` could double-append to `index.jsonl` (both processes passed the active-run check); the pointer is claimed by removal before the append. The session-graph `.active` pointer writes atomically, and a corrupt pointer fails with `ACTIVE_POINTER_CORRUPT` + remediation instead of flowing garbage into path joins
- `gk gate` BLOCK verdicts print the human verdict table plus a `Missing: … — produce <dir>/<key>.md` repair hint (was the JSON sha256 wall in both modes — the output a graph-run operator sees most); `--json` keeps the full machine envelope for scripts
- Truthful onboarding hints: `graph list` no longer suggests the non-existent `gk init-graph` (it's the `/gk:init-graph` session skill); `init`/`new` next-steps name CLI commands that exist identically on every host; `graph new` without an argument leads with the usage line; `memory recall` distinguishes "no store yet" from "no match"; `inventory --help` no longer prints "(default: claude)" twice. A guard test resolves every backticked `gk …` hint in command sources against the command registry
- `gk run node --advisor-fired` and `gk run resume` on a broken graph.yaml now fail with `GRAPH_FILE_NOT_FOUND`/`SCHEMA_INVALID` via the shared loader (was a misleading `BAD_ADVISOR` blaming the node); a corrupt criteria registry file is a `criteria-file` finding, not a crash of `gk validate`; CRLF-authored frontmatter (memory, criteria, markers, agent files) parses instead of registering as "no frontmatter"
- **`gk memory touch` silently dropped legacy entries with string `tags:`**: decay (`memory trace`) coerced legacy string tags back to arrays but reinforcement did not, so those entries never scored reinforcement. Shared `parseMemoryFile` (`src/memory/frontmatter.ts`) now serves both paths; regression-tested
- **No-op `--json` flags made honest**: `gk gate`, `gk status`, `gk inventory`, `gk init`/`new`, `gk run status`, `gk memory recall` advertised `--json` in help but ignored it and always printed one-line JSON. Default output is now human-readable (gate prints `VERDICT:` + per-key table instead of a wall of sha256 hashes; the manifest stays `--json`-only; fail envelopes stay JSON in both modes), and `--json` prints the exact previous envelope — README's "`gk status` # human-readable" is now true
- **`bun run ci:local` was weaker than CI**: it skipped `check:parity` and the cli-manifest drift guard, so a contributor could pass the "THE gate" and still red CI. Both gates added (CONTRIBUTING/README updated to match)
- **Kit SKILL.md frontmatter was invalid YAML**: 52/57 shipped `kits/**/SKILL.md` files had unquoted `: ` inside `description:`/`when_to_use:` scalars, so strict YAML parsers rejected them. All values quoted (text unchanged); `tests/unit/kit-skill-frontmatter.test.ts` committed as a regression guard. Kit `metadata.json` versions synced to 0.3.0.
- `gk memory trace|touch|recall` crashed with a raw stack trace on syntax-broken memory frontmatter; malformed entries are now skipped like shape-invalid ones and the CLI paths emit structured errors (`MEMORY_TRACE_FAILED` / `MEMORY_TOUCH_FAILED`)
- CBM client `close()` waited a fixed 1 s for already-exited children (spawn-failed children never fire `exit`); now resolves immediately and escalates to `SIGKILL` on the grace timeout
- Run-ledger `.active` pointer used check-then-write (two concurrent `gk run start` could both win); creation is now exclusive (`wx`) with the same `RUN_ACTIVE` error, and a stale pointer (run dir vanished) is recovered instead of deadlocking
- Memory/ledger/evidence in-place rewrites were non-atomic (interrupt could destroy prior content); shared `atomicWrite` (sibling temp + rename) applied across `memory`, `consolidate`, `links`, `ledger`, `evidence store`, `template`

### Changed
- **Memory-path perf + a perf harness that measures it**: `expandedRecall` link expansion uses an id→doc Map (was `Array.find` per neighbor over the whole store); `buildLinks` grows entity lists by push (was an O(m²) copy per insert) and `.links.json` is written compact (it re-parses on every recall); `consolidate` skips identical rewrites (stable mtimes — freshness readers and stat-based caches stop churning). The synthetic stores in `bun run perf` now carry a populated link graph, and the harness adds a `buildLinks` (store-walk) column and a startup-floor row (bare node vs `--version`) that explains the flat per-invocation CLI cost
- **Finish the error-contract + parsing unification**: `runInventory` throws typed `BAD_TARGET`, `resolveValue` throws `PARAM_INVALID` at the source (callers no longer re-derive codes from message text), CBM failures classify via `isCbmUnavailable` (the package-name string-sniff lived in two command files), and the template-name message is built from `TEMPLATE_NAME_RE.source` (three hand-copied regex strings); one CRLF-tolerant `splitFrontmatter` replaces four divergent copies of the frontmatter regex; `run.ts`/`resume.ts` load graphs through the shared `loadGraph`; the last `as any` casts are gone from the compiler (schema already typed those fields)
- **`gk graph` CBM subcommands collapse to one dispatch path** (backlog R7) — the four near-duplicate search/ask/trace/query bodies (error handling, flag validation, client lifecycle) become a shared runner; previously-untested `INVALID_LIMIT`/`INVALID_DEPTH` CLI paths now covered. The 515-line YAML template block moved to `src/cli/graph-templates.ts`; `loadGraph`/`resolveBareValidateGraph` moved to `src/compiler/loader.ts`; SVG/ASCII renderers take the zod `Graph` (4× `as any` casts and hand-rolled duplicate graph types removed)
- **Memory/ledger errors are structured end-to-end**: `ledger`/`resume`/`consolidate` throw `GraphKitError` (codes and messages unchanged, so existing matchers hold) instead of `Error("CODE: msg")` that the CLI regex-parsed back apart; error `details` now reach fail envelopes (`RESUME_RUN_NOT_FOUND` can carry available run ids); shared `readJsonl`/`walkMemoryStore` helpers replace triplicated parsing loops
- **Recall/perf hot paths**: `gk memory recall` reinforces each hit by path (O(k) file reads instead of up to 5 full store rescans); `resolveSuperseded` de-duplicates via `Set` (was O(n²)); `fingerprint()` issues one `git ls-files -mo` spawn instead of two (`--no-optional-locks`, ~15-20 ms off every `gate`/`status`/`evidence report`/`run start`)
- Removed unused `ajv` + `ajv-formats` dependencies (zod migration leftover, −2.4 MB install)
- dagre is now lazy-loaded on first `gk graph svg` render instead of at CLI startup
- CI gates: `check-cli-parity` + manifest drift guard run in CI; release workflow runs typecheck + tests before packaging; `docs/diagrams/*.json` biome-formatted (lint green)
- **Pages landing page rewritten version-free** (`docs/graphkit.html`, renamed from `graphkit-v0.2-report.html`): features ordered as a workflow — lifecycle → install → 11 topologies → per-node binding & validation → dual runtimes → evidence & gates → run ledger & resume → memory & CBM bridge → host table → CLI. All version badges, "shipped in X.Y" labels, dated sections, roadmap, and historical demo/story sections removed. `pages.yml` redirect updated.
- **Landing page visual pass**: topology cards now carry animated SVG diagrams (traveling signal dots via SMIL `animateMotion`, node pulse, edge dash-flow, hover gradient glow, scroll-driven reveal under `@supports`, `prefers-reduced-motion` fallback; zero JS). "Comprehensive Command Reference" gains "The gk Lifecycle" — a 6-stage orchestration flow diagram (install → compose → validate → execute → evidence & gate → close out) with animated connectors, MERGE/BLOCK/RESUME verdict chips, and a BLOCK→resume loop-back lane — plus per-stage session-skill chips and a 13-card "Session Skills" grid.

## [0.3.8] - 2026-09-05
### Fixed
- CI lint: auto-formatted run-resume sources (biome `useTemplate`/`useConst`/import order/format). No behavior change — 575 tests pass.
## [0.3.7] - 2026-09-05
### Changed
- Docs only — no code changes. Page title tag de-versioned.

## [0.3.6] - 2026-09-05
### Changed
- **Landing-page restructure** (`docs/graphkit-v0.2-report.html`): sticky nav (Quickstart/Architecture/Topologies/Runs/Memory/CLI/Roadmap/GitHub), hero CTAs + copyable install one-liner, "Author · Run · Remember" track cards, section anchors, roadmap S1 marked SHIPPED 0.3.5, footer links (repo/CHANGELOG/specs), stats 542→575.
- **README**: CI/Release/Pages/Tests badges, counts headline, TOC, `gk run resume` reference, stale test count 461→575, CLI help copy now lists `resume`.

## [0.3.5] - 2026-09-05
### Added
- **`gk run resume <run-id>`** — checkpoint replay: reconciles the run ledger against the recorded graph (`passed` + evidence-on-disk rule, dependent closure), derives a pending-only session graph where satisfied upstream evidence becomes `refs`, activates it, and starts a child run carrying `resumes:` provenance. `gk run status` now prints the `resumes_chain`. Guards: `RESUME_GRAPH_DRIFT` (sha256 of the recorded graph), `--force` override, `--from-node` redo, `--dry-run` preview; derived graphs are fail-fast validated (`RESUME_DERIVED_INVALID`) — fan_out/loops/required_keys closure included.
### Changed
- **Pages report: checkpoint-resume section added** — reconcile → derive → child-run flow documented with drift-guard guidance (see `docs/graphkit-v0.2-report.html`).

## [0.3.2] - 2026-09-04

### Added

- **Node advisor escalation**: a looping node may declare `advisor: {model, after_failed_rounds, max_calls}` — once a node's failed-round streak reaches `after_failed_rounds` (and `max_calls` per run isn't exhausted, within `loop.max_rounds`), the execute-skill dispatches a read-only advisor subagent at `advisor.model` (default `fable`), appends its guidance (`## Advisor guidance`) to the node objective, and re-dispatches the node at its original tier.
- **Escalation audit trail**: `gk run node <id> --advisor-fired <round> [--streak <n>]` appends to the run's `advisor.jsonl`; `gk run status` reports the `advisor_events` count.
- **Node fan-out**: a node may declare `fan_out: {briefs_from, template}` — the upstream node's `briefs.json` (array of `{id, title, body}`) executes as one parallel host subagent per brief (`template` rendered per brief, default `{brief.body}`) with an in-node barrier and consolidation; the waves payload carries `advisor`/`fan_out` verbatim.
- **`advisor-repeat` memory pattern**: `gk memory consolidate` surfaces repeated advisor escalations with a "raise model tier / loosen stop_when" suggestion (action `review-failure`).
- **Advisor/fan-out execute-skill mechanics + e2e**: all five kits' execute skills dispatch advisor escalations and fan-out briefs; `tests/acceptance/advisor-fanout.e2e.test.ts` covers the CLI path end-to-end.

### Fixed
- **Two scaffolds failed their own validator**: `gk graph new diamond` and `gk graph new loop-until-done` emitted a `limits:` block the validator rejects (`max_workers` / `max_iterations` are not schema keys), so quickstart step 3 (`gk validate`) failed on the README's own topology. The dead `limits:` blocks are removed, and a CI sweep now asserts every scaffold parses and validates clean (`tests/unit/scaffold-validate.test.ts`, 11 topologies).
- **Bare `gk graph` / `gk template` / `gk models` crashed with a raw CACError stack trace**: all three group commands required a subcommand. They now make it optional and print usage with exit 0, matching the `gk memory` surface.
- **`ENOENT` surfaced as raw Node text inside error envelopes**: a missing graph file in `validate`/`compile`/`gate`/`ascii` now fails as `GRAPH_FILE_NOT_FOUND` with the path and a next-step hint (`gk graph new <topology>`).

### Changed
- **`/gk:visualize` defaults to archify HTML**: the skill reads `gk graph waves`, authors a typed [archify](https://github.com/tt-a1i/archify) IR (wave index → column, model tier → lane), validates it at showcase quality with a 5-cycle cap, and delivers a self-contained `.graphkit/diagrams/{name}.html` plus its `.archify.json` source. archify is skill-layer only — probed per host, installed once with user consent, with SVG fallback when unavailable. ASCII, SVG, and Excalidraw modes unchanged.

### Removed
- **Local interactive viewer**: the key-gated `127.0.0.1` SSE server, dagre bundle, viewer assets in all five kits, `bun run build:viewer`, and the viewer test suite are deleted in favor of the archify artifact.

### Fixed
- **Stale kits shadowing a newer install**: `kitSourceDir()` probed `<bin>/../share/gk/kits/` before `<bin>/share/gk/kits/`, so a kit left by an earlier install under a different prefix (e.g. `~/.local/share/gk/`) outranked the kit shipped in the current binary's tarball — `gk init` silently installed the old kit. The side-by-side layout is now probed first.
- **Retired kit assets surviving upgrades**: `gk init` overlays the kit with `cpSync`, which never deletes, so files a newer kit stopped shipping lingered in existing projects. Each kit's `metadata.json` `deletions` list is now honored on every install; the claude, cursor, and opencode kits declare the removed `viewer` directory.
- **Sudo-free install documented**: the README's primary install is now `tar -xz -C ~/.local/bin` — the binary resolves its kits from the adjacent `share/gk/` tree, so any writable dir on `PATH` works. The `sudo` variant remains as the system-wide option, with notes on overlay-only upgrades and shadowed stale copies.

## [0.3.0] - 2026-09-04

### Added

- Run ledger: `gk run start|node|end|status` records every execution to `.graphkit/runs/`.
- Pattern compiler: `gk memory consolidate` derives node sequences, evidence co-occurrence,
  failure recurrence, and graph reuse into `.graphkit/memory/patterns/` + `suggestions/`.
- Suggestions: `gk suggest` ranks them; `--dismiss` retains the file but hides it.
- Recall widened: searches subfolders, joins `.links.json` neighbors below direct hits.
- Dream graph template: proposes memory consolidations as reviewable diffs (`.graphkit/inbox/`).
- Waves payload carries `hooks` (on_node_complete) and `on_graph_complete` commands.

## [0.2.25] - 2026-08-27

### Added
- **Session graph store**: graphs are immutable timestamped sessions under `.graphkit/graphs/<YYYY-MM-DD>-<slug>.yaml` with an active pointer at `.graphkit/active`; root `graph.yaml` keeps working via explicit path, and same-day id collisions suffix `-2`, `-3`, …
- **Session graph commands**: `gk graph list` (session table with created/last-run columns and an active marker — last-run shows `-` until the runs ledger ships with `gk execute`), `gk graph switch <id>` (flip the active pointer), `gk graph show [id]` (print a session's YAML; defaults to the active graph), and `gk graph topologies` (list bundled topologies — topology listing moved off `graph list`, which now means session graphs).
- **Loop groups**: top-level `loops:` array repeats a contiguous multi-node wave span with hybrid stop semantics — deterministic `gate_evidence` check first, LLM-judged `stop_when` fallback, `max_rounds` hard cap; exhaustion fails the run and records rounds executed plus the stop reason (`gate` | `judged` | `exhausted`).
- **Loop group validation**: node existence, wave-span contiguity, non-overlapping groups, and every `gate_evidence` key declared on a node inside the span are checked in `validateGraph`; `max_rounds ≥ 1` and stop-condition presence (`stop_when` and/or `gate_evidence`) are enforced by schema validation (`SCHEMA_INVALID`).
- **Template materialization**: `gk template materialize <name> [--params '<json>'] [--use]` resolves project-local ⇒ user-global ⇒ bundled gallery, substitutes parameters, validates, and writes a new session graph (`--use` sets it active). Ships a builtin gallery of 4 templates (`audit-pr`, `refactor-module`, `bench-eval`, `doc-sweep`); `gk template list` gains an `origin` field (`project` | `global` | `gallery`).

## [0.2.24] - 2026-08-26

### Fixed
- Fixed release notes extraction in `release.yml` so CHANGELOG entries match date-suffixed headers.

## [0.2.23] - 2026-08-26

### Added
- **Changelog & Documentation Policy**: `CHANGELOG.md` covering all releases from `v0.2.0` onward.
- **Release workflow integration**: `release.yml` extracts the current version's section from `CHANGELOG.md` to populate GitHub Release notes.
- **CI sanity check**: `scripts/check-changelog.ts` ensures `CHANGELOG.md` exists and contains an `[Unreleased]` section (wired into `ci:local`).
- **CLI Reference**: full 30-command reference in `README.md`.
- **Command documentation**: `gk status`, `gk execute`, and `gk visualize` pointer stubs documented in `README.md`.
- **Worktree merge protocol**: `docs/worktree-merge-protocol.md` with sequence diagram and multi-host support matrix.
- **Pages integration**: `docs/worktree-merge-protocol.md` linked from GitHub Pages index.

### Changed
- `README.md` banner links directly to `CHANGELOG.md` and `docs/worktree-merge-protocol.md`.

## [0.2.22] - 2026-08-25

### Fixed
- Biome formatting and unused symbol cleanup across all F4–F9 touched files.
- Local Biome check exclusion for untracked `.omp/skills/excalidraw-diagram`.

## [0.2.21] - 2026-08-25

### Added
- **Conflict-safe worktree merge protocol**: `git merge --no-commit --no-ff`, automatic `git merge --abort` on conflict with full node/branch/file reporting, gate test verification before sealing merge.
- **Real `gk status` command**: reads `.graphkit/runs/.active`, summarizes active run metadata, round status, and evidence gate coverage.
- **CLI alignment**: `gk execute` and `gk visualize` pointer stubs (`NOT_IMPLEMENTED`, exit 1) guiding users to the corresponding `/gk:*` skills.
- **Bounded upstream context**: downstream agents in custom workflows receive declared evidence paths and at most a 2KB tail per dependency rather than full raw results.
- **Symbol-first context profile**: documentation (`docs/context-profiles.md`) and verified example (`examples/symbol-first.yaml`) for bounded structural indexing via `codebase-memory`.
- **Degenerate-graph guard**: validator rejects zero-node non-custom graphs.
- **`gk init` scaffold**: creates `.graphkit/{evidence,reports,memory,runs}` directory layout.
- GitHub Pages index now links `context-profiles.md`.

### Changed
- Refactored `skill-eval` and `skill-recall` unit tests from substring matching to functional CLI execution.

## [0.2.20] - 2026-08-24

### Fixed
- Added accessible `<title>` elements to graph viewer SVG outputs.

## [0.2.19] - 2026-08-24

### Fixed
- Kit installation writes to `.omp/` for Oh My Pi runtime auto-discovery.

## [0.2.18] - 2026-08-23

### Changed
- Added research and repair workflow for memory-improvement graphs.

## [0.2.0] - 2026-08-11

### Added
- Multi-host target kits: Claude Code, Cursor, OpenCode, Codex CLI, Pi (`.omp`).
- Custom and built-in topology validation and compilation.
- Interactive Graph Viewer (`gk visualize`) with live SSE reload.
- Cross-run project memory subsystem (`gk memory recall/touch/trace`).
- Deterministic evidence gate (`gk gate`).
