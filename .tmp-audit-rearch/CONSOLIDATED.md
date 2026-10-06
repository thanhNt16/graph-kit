# CONSOLIDATED — graph-kit re-architecture audit (12 reports → 1)

**Source legend** (report-id = file in this directory): SIT=SkillInitTemplate.md · CLI=cli-surface.md · CS=compiler-schema.md · EL=evidence-ledger.md · ES=evidence-status.md · EXT=extension-layer.md · GAL=gallery-templates.md · MEM=memory-consolidate.md · SB=skill-brainstorm.md · SRE=skill-recall-eval.md · SVV=skill-validate-visualize.md · UX=ux-journey.md. All CLI-behavior claims below were empirically verified in scratch runs by the source audits (installed gk 0.3.34 / repo src 0.3.0 unless noted). Merged rows keep the max source severity; where one source finding has facets landing in two merged rows, it is cited in both. Nothing here is asserted that a source report does not state.

---

## 1. Executive summary

- **Latency is exonerated.** Every `gk` call measures 60–250 ms and both audited flows spend < 5 s total in CLI time (EL F10, UX F10). The slowness the user felt ("init→execute took very long, against my first intention") is **procedural**: steps, flags, hand-copied state, and recovery from failures.
- **Measured cost of one 3-node template run** (UX): 9 commands for a fully informed user; **19 commands with 6 failures** following gk-init-graph literally; **21 commands with 2 failures** following gk-execute; end-to-end ≈ 24 gk invocations + 3 evidence file writes + 3 subagent batches + 2 skills read (482 lines). The happy path spans **13 command paths across 6 namespaces** of the 56 that exist (~1 in 4 is load-bearing) (CLI). Ledger minimum ≈ 3N+K+3 fresh node processes (EL F10).
- **The 8 observed failures collapse to 4 root causes**: undocumented `gk init` prerequisites (two inits, wrong default target), graph identity/resolution incoherence (id vs path vs active pointer; session graph vs `./graph.yaml`), skill docs describing nonexistent surface, and template-param/graph-input double entry (UX divergences 1–6).
- **Structurally**: validation is spread across three gates of different strength, and the state-creating step (`run start`) validates least — errors land 1–2 steps late with a cleanup tax (CS#1, CS#2, SVV F1/F2).
- **State truth is split three ways**: the ledger, a ghost `current.json` nothing writes, and skill docs describing fictional files all claim to answer "what is running" (CLI F1, ES E4, ES E8).
- **Quiet corruptors compound the delay**: wrong graph left active (SIT F5), provenance silently destroyed by `--note` text (ES E3), ledger lost-update race (EL F1), consolidate wiping reinforcement state every run (MEM F3), a 6-command always-fail CBM surface (MEM F4).
- **Healthy and kept**: per-call latency, the kit materialization pipeline (verified E2E, EXT F8), atomic writes, strict schemas, fingerprints/artifacts, the archify flow, `topoWaves` as a shared seam.
- **Fix shape** (§5–§7): one graph resolver, one event store with projections, one planner IR, one declared-input layer, validate-at-start, fused plan/start → ~7 invocations on the common path, 1–2 via a cold-start `gk up`.

## 2. The init→execute death-map

Merged friction log across all 12 reports. Commands in `code`, failures in **bold**.

### Stage A — Bootstrap
| # | Step | What actually happens | Failure / cost | Refs |
|---|------|----------------------|----------------|------|
| A1 | install `gk` | version provenance unclear (0.3.34 installed vs 0.3.33 contract vs 0.3.0 repo) | drift risk, audit ambiguity | EXT F10; SIT F10; SVV F9; ES note; SRE/MEM/GAL headers |
| A2 | `gk init` | **required by materialize + agents but undocumented in either skill**; discovered only via late failure at step 6 of 7 | **GRAPHKIT_NOT_INITIALIZED** | SIT F2; UX F2; GAL friction-1 |
| A3 | default `gk init` | installs `.claude/agents`; native dispatch reads `.omp/agents` only → **second init `--target pi` required** | **AGENTS_DIR_MISSING** wall mid-flow | GAL F2; UX F2; SVV F1 |
| A4 | codex installs | `gk validate` false-**VALIDATION_FAILED** on every codex install (`.toml` never stripped) | hard block at the first gate | EXT F1 |
| A5 | omp flow | `graph agents` additionally needs `.omp/agents` + base agent fragments | 4th undiscovered prerequisite | CLI F2; SVV F1 |

### Stage B — Discover
| # | Step | What actually happens | Refs |
|---|------|----------------------|------|
| B1 | `gk template list` / `gk graph topologies` | two namespaces for one discovery act | CLI friction-1; SIT friction-2 |
| B2 | `gk template show <name>` | returns counts only — cannot answer init-graph steps 3–4 (params/recommendations) | SIT F3; GAL F9; UX F7 |
| B3 | (undocumented hop) raw-`read` the gallery `.gk.yaml` at an absolute path inside the global npm install | only way to learn params/recommendations | SIT F3 friction-4; GAL friction-3 |
| B4 | `gk suggest --json` | **empty on fresh projects**, no empty-case behavior → literal agent stalls | SB F4 |
| B5 | `gk graph inspect custom` | `config_keys: []` — dead-end exactly where config is richest | SB F5 |
| B6 | `gk template materialize diamond` (unknown name) | TEMPLATE_NOT_FOUND, no hint `diamond` is a topology | SIT F12 |
| B7 | one hand-edited corrupt template in the store | **poisons list/show/materialize-suggestions** with an error naming the wrong target | SIT F6 |
| B8 | `gk graph waves <t>.gk.yaml` | **SCHEMA_INVALID, remedy unnamed** — no pre-materialize preview exists | GAL F1 |

### Stage C — Author / materialize
| # | Step | What actually happens | Refs |
|---|------|----------------------|------|
| C1 | `gk graph new <topology>` | raw YAML to stdout, `--json` ignored; agent must capture, write the file, hand-implement naming/collision, then `graph switch` (~4 agent-implemented steps on the canonical path) | CLI F5.2; SIT F10/friction; SVV friction-1; CS friction-1 |
| C2 | `gk template materialize --params '<json>'` | JSON blob on CLI; MISSING_PARAMS is clean but arrives after the agent already guessed blind | SIT F3; GAL friction-4 |
| C3 | omit `--use` | skill prose claims one-command write+activate; silently leaves the **previous graph active** → wrong-graph execution risk | SIT F5 |
| C4 | `gk template pack graph.yaml --name X` (the documented command) | **silently packs `parameterCount:0`, losing all prepared decisions**; real path needs hand-authored file + `--input` + a dummy positional; no pack-time schema check; `--name` vs `metadata.name` can silently diverge | SIT F1; SIT F9; SIT F7 |
| C5 | authoring sharp edges | constraints as array-of-single-key objects; `outputs.evidence_dir` + `evidence:` mandatory even with no keys; three loop idioms across the gallery; empty-string defaults produce `"Focus theme: . Cutoff: ."` litter; skill teaches dead `assigned_only` key | EXT friction-2; GAL F4; SIT F11/GAL F7; SB F1 |
| C6 | cook-plan | cannot be told its goal (no parameters, no inputs, `--input goal=` rejected) | GAL F6 |

### Stage D — Validate
| # | Step | What actually happens | Refs |
|---|------|----------------------|------|
| D1 | `gk validate` | two resolution rules (bare prefers session graph, explicit prefers the path); `run start` prefers root — **validate can pass a different graph than execute runs** | CLI friction-3; SVV F10; SB F2 |
| D2 | schema vs semantic failures | two envelope shapes; superRefine masked by earlier unknown-key errors → **N+1 round-trips**; agents parsing `details.findings` never see `details.issues` | SVV F2 |
| D3 | agent binding | **false-green** when no agent dir (check skipped); **false-red** on codex; kebab-vs-raw name lookup; 6-dir probe vs `.omp`-only materializer | CS#2; EXT F1; CS#6; SVV F1; GAL F10 |
| D4 | environment probes | validate mixes fs checks with shape checks; cwd-relative refs emit phantom blocking findings | CS#7; SB F9 |
| D5 | PASS contract | skill quotes payload text that no command emits; "fails fast" wrong in both directions | SVV F4 |
| D6 | validate → waves → agents | **3 redundant full validateGraph passes** (4th if visualizing) | CLI F2; CS friction; SVV friction |
| D7 | healthy-but-uninitialized project | validate PASS → agents FAIL → init → agents OK → waves OK = **5 invocations where 2 suffice** | SVV friction |

### Stage E — Start
| # | Step | What actually happens | Refs |
|---|------|----------------------|------|
| E1 | `gk run start --graph <session-id>` | **the id materialize just returned is rejected** (GRAPH_NOT_FOUND); `--graph` treated as verbatim path; only full path or omission works | UX F1; UX flow1 steps 10–12 |
| E2 | `gk run start` on an invalid graph | **zero validation**: starts, exit 0; schema failure surfaces 2 steps later, after state creation, requiring `take`/`end` cleanup | CS#1 |
| E3 | required inputs | **MISSING_INPUTS: the value given at materialize must be typed again** (params and inputs are unlinked namespaces) | SIT F4; GAL F5; UX flow1 step 11 |
| E4 | stale run | RUN_ACTIVE blocks; requires `run take --from <id>` first | CS friction-3; EL friction-7; CLI friction-4 |
| E5 | resolution asymmetry | run start honors active-pointer-on-omission; waves/agents/validate/gate don't | UX divergence-6; SVV F10; ES E4 |

### Stage F — Plan & dispatch prep
| # | Step | What actually happens | Refs |
|---|------|----------------------|------|
| F1 | `gk graph waves` | 3rd full parse; re-reads raw YAML for role/eval; **drops `topology_config`**; curator double-counted in `total_nodes` | CLI F2; CS#4; CS#13; SVV F7 |
| F2 | `gk graph agents` | materializes `gk-<node>.md` into `.omp/agents` only; fails on default installs; agent names must be hand-copied onward | GAL F2; SVV F1; EXT friction-4 |
| F3 | spawn prompt | agent hand-writes `run: <id> node: <id> rev: <sha[:12]>` header from the start payload | CLI friction-7; UX state-list; EXT friction-4 |

### Stage G — Execute loop (per node)
| # | Step | What actually happens | Refs |
|---|------|----------------------|------|
| G1 | ledger calls | minimum **3 per node** (dispatch → node → land); ~6 with extension/worktree mode + manual merge/owns loop | EL friction-3; EXT friction-6; CLI friction-8 |
| G2 | naming | **three names per node** (node id / `agent:` field / materialized `gk-<node>`), threaded by hand, never validated | UX F5 |
| G3 | `run dispatch` | without `--pid` the dispatch is unliveness-checkable; `take` can unblock under a live agent | EL F7 |
| G4 | `run land` / `run node` concurrency | **landNode read-modify-write race silently deletes concurrent trace lines** (verified) | EL F1 |
| G5 | `gk status` mid-run | reports `run:null` — **unless the agent hand-writes `current.json` per kit instruction** | CLI F1; ES E4; ES E8 |
| G6 | `gk run end` | accepts `merged` with 1/3 nodes and 0/1 required evidence — **gate invoked only by agent discipline** | UX F4; UX flow1 step 19 |
| G7 | flags | 17-option shared bag on `run`; `--status` means two different enums (node vs end); usage lives in prose | CLI F7; UX F8 |

### Stage H — Evidence
| # | Step | What actually happens | Refs |
|---|------|----------------------|------|
| H1 | per key | **2 steps ×K** (write `<evidence_dir>/<key>.md` + `gk evidence add`); key must be pre-declared; `run node --evidence` records keys on the trace but does NOT stamp the file — two evidence systems | UX F6; EL friction-4; CLI friction-9 |
| H2 | `--node <id>` | **parsed then silently discarded** — producing-node provenance unstampable; report's node line can never fire | ES E2; CLI F5.6 |
| H3 | `--note "verified: yes"` | naive frontmatter interpolation → invalid YAML → **all provenance vanishes from report, exit 0, no warning**; invalidate then drops the unparseable fields | ES E3; EL F3 |
| H4 | absolute artifact path | mangled to `<cwd>/tmp/…`, not rejected | ES E7 |
| H5 | node-declared non-required keys | stampable but **invisible** to report and gate (required_keys enumerated only) | ES E6 |
| H6 | stamping outside a run | no `run_id` → never foreign, never chain-satisfiable — lineage forfeited silently | EL friction-4; ES friction-2 |
| H7 | untracked scratch files | flip `fingerprint_tree` → **every earlier marker goes "stale" spuriously** mid-run | EL F4 |

### Stage I — Gate & report
| # | Step | What actually happens | Refs |
|---|------|----------------------|------|
| I1 | `gk gate` | **first re-validates the whole graph** — an unrelated typo elsewhere yields VALIDATION_FAILED instead of a verdict | SRE#2 |
| I2 | `freshness: strict`, non-git repo | **unpassable**, with a remediation hint telling the user to run the command they just ran | SRE#3 |
| I3 | post-hoc gate | **silently passes foreign evidence** (lineage check skipped with no active run); same artifact BLOCKs mid-run — phase-dependent verdicts | SRE#4 |
| I4 | status vs gate vs report | **three truth models for the same files**: `foreign` dead in report, status gates without strict, superseded badges only in report | ES E1; ES E4; SRE#4 |
| I5 | `evidence report --html` | **silent write** to a hardcoded path; `outputs.report` schema is a dead-letter | ES E9; CLI F3.4 |

### Stage J — End & memory payoff
| # | Step | What actually happens | Refs |
|---|------|----------------------|------|
| J1 | `gk run end` → `gk memory consolidate` | consolidate is **manual, skill-mandated**; forgetting it freezes the store | MEM F6; UX flow2 step 21; SRE friction-3 |
| J2 | consolidate after reinforcement | **wipes `use_count`/`last_used_at`, resurrects `expired:true`, resets `created_at`** — in the documented flow, reinforcement never survives a run boundary | MEM F3 |
| J3 | first runs | store **empty below 3 runs**; thresholds are private constants; no explanatory output | SRE#5; MEM F1 |
| J4 | recall | 87.5% of the store is pair-noise; salience non-discriminating; **PPR link expansion is dead code** → ≈ arbitrary 5 files | MEM F1; MEM F2 |
| J5 | content memories | **nothing can write them** — no `memory add`; only hand-authored frontmatter files | SRE#5 |
| J6 | `graph search|ask|trace|query|index`, `memory index` | **CBM_UNAVAILABLE on every call** — dead backend shipped as 6 commands | MEM F4 |
| J7 | recall side effects | mutates store + appends `injected:true` unconditionally; `--explain` (the one good debug lens) is absent from the skill | SRE#9; SRE#8; SRE#6; MEM F9 |

### Cross-cutting
- **Latency**: 60–250 ms/call, < 5 s CLI per flow, fingerprint +110 ms/128 MB dirty — "per-call latency is NOT the friction — command count is" (EL F10; UX F10).
- **State a user/agent must hold** (UX): graph path-or-omission rule, dead graph id, run id, `graph_sha256`, input key names, node ids, materialized agent names (≠ node id ≠ `agent:` field), evidence keys + path convention + required subset, wave indices, attempt numbers, `--via` enum, two `--status` enums, two init invocations with different targets.
- **Mandatory flags**: 8 across the flow (UX); ~15 on the CLI happy path; 3 sequencing rules that exist only in skill prose (waves-before-dispatch; agents-after-start+correct-target; evidence-before-gate) plus dispatch-intent/stamp-before-gate/gate-before-end enforced by discipline alone (CLI; UX DIP).
- **Tallies**: UX 19 cmds/6 fails + 21 cmds/2 fails, 8 failures → 4 root causes · CLI 13 paths/6 namespaces · SIT 7–9 calls + 1 raw read + 1–2 user gates + 1 duplicate entry, hard failures at steps 1/7/9 · EL 3N+K+3 · GAL 4–8 cmds + 2 latent platform walls vs theoretical minimum 2 · SVV 5 vs 2 · SRE 6+ cmds of which 2 serve the goal.

**Hand-copied values inventory**: graph id (returned then rejected — UX F1) · full session path typed by hand, date-embedded (GAL friction-5) · run id + sha into dispatch headers (CLI friction-7; EXT friction-4) · node ids ×N, wave indices, attempt numbers (UX) · `gk-<node>` agent names (UX F5) · param values twice (SIT F4) · evidence keys + required subset (UX) · dummy positional for `pack --input` (SIT F9) · `current.json` hand-written by the agent (CLI F1) · `--from <run-id>` for take despite working positional (CLI F5.5).

## 3. Findings by severity

Deduplicated; each row = report-id + finding id (file:line where the source gave it). Merges take the max source severity.

### CRITICAL
- **C1** — `gk-template` step-8 commands omit `--input`, so a literal pack silently produces `parameterCount:0` and every decision from steps 2–7 is lost (template.ts:79-110, 113-123). *SIT F1*
- **C2** — `gk init` is an undocumented prerequisite: fresh projects die at step 6 of 7 with GRAPHKIT_NOT_INITIALIZED (template.ts:328; store/index.ts:14-15); neither skill names it at point of need. *SIT F2; UX F2*

### HIGH
- **H1** — Template `parameters` and graph `inputs` are two unlinked parameterization namespaces: every value is entered twice (materialize `--params` + run `--input`) and declaring a name in both layers diverges silently — "the single biggest hidden tax on init→execute" (template.schema.ts:106-119 even forbids bridging defaults). *SIT F4; GAL F5*
- **H2** — Graph identity/resolution is per-command guesswork: materialize returns an id that `run start` rejects (run.ts:96 treats `--graph` verbatim); bare validate prefers session graph while run start prefers root `graph.yaml` (graph.ts:95-109 vs run.ts:95-100); `status` takes no `--graph` at all. *UX F1; SB F2; SVV F10; ES E4 (resolution facet)*
- **H3** — Skill protocol split-brain: gk-init-graph writes immutable session graphs (`.graphkit/graphs/` + `.graphkit/active`) while gk-execute's literal commands assume `./graph.yaml` — execute step 1 fails on init's output; "the compiler is an LLM reading two documents that disagree". *UX F3; SB F2*
- **H4** — Top-level `gk status` is structurally broken: reads `.graphkit/runs/current.json`, which nothing writes (status.ts:24-32), reports `run:null` during live runs unless the agent hand-writes the file per kit instruction; hardcodes `./graph.yaml`; calls gate without `strict` so it can say MERGE where gate says BLOCK. *CLI F1; ES E4*
- **H5** — Default `gk init` target ≠ native-dispatch target: plain init writes `.claude/agents`, materialization reads `.omp/agents` only (node-agents.ts:64-70) → AGENTS_DIR_MISSING wall + second init; validate probes 6 host dirs first-hit-wins so multi-host repos validate against the wrong one. *GAL F2; UX F2; SVV F1; EXT F9*
- **H6** — Agent-binding gate unreliable in both directions: false-PASS when no agent dir exists (`if (agentDir && …)`, validate.ts:26-36,48); false-FAIL on every codex install (`.toml` never stripped; inventory.ts:138-141 already handles both); kebab-case vs raw `${node.agent}.md` lookup divergence. *CS#2; EXT F1; CS#6; GAL F10*
- **H7** — `gk run start` performs zero validation (ledger.ts:118-191): schema-invalid graphs start with exit 0; failure surfaces at waves/agents, 2 steps late, after state creation, with a take/end cleanup tax. *CS#1*
- **H8** — Two failure envelopes (SCHEMA_INVALID `issues` vs VALIDATION_FAILED `findings`) + superRefine masked by earlier unknown-key failures force N+1 validate round-trips; agents parsing `details.findings` per the skill never see `details.issues`. *SVV F2*
- **H9** — Envelope contract ~90% with 4 documented leaks (`graph new` raw YAML + ignored `--json`; `graph ascii` raw; `memory recall --html` bare path; `evidence report --html` silent write) and decorative `--json` flags on always-JSON commands. *CLI F3; SVV F6; ES E9; ES E10*
- **H10** — No intermediate representation: the real execution planner (~140 lines incl. curator interleave) lives inline in cli/commands/graph.ts:821-963; every consumer re-reads/re-parses YAML (≈5 parses per init→execute); emitter/resolver serve only the legacy compile path. *CS#3; CLI F2; SVV F7*
- **H11** — Topology is decorative in native mode: waves payload drops `topology_config` (graph.ts:940-961); `topology_config` is `z.any()` with a docs-only keys table (graph.schema.ts:202-204); gallery labels lie (dream/audit-pr are chains under `diamond`); waves re-reads raw YAML bypassing the schema it just ran. *CS#4; CS#5; GAL F3; CS#13*
- **H12** — Template files are second-class across the graph CLI: waves/ascii/svg/agents/compile/gate all reject `.gk.yaml` (SCHEMA_INVALID, remedy unnamed); no pre-materialize preview exists. *GAL F1*
- **H13** — `gk template show` returns counts only (template.ts:337-369): no parameter names/defaults/descriptions/recommendations; init-graph steps 3–4 impossible without an undocumented raw read of the global npm install. *SIT F3; GAL F9; UX F7*
- **H14** — `--use` is optional while the skill claims "one command writes the file and sets it active" (template.ts:330-333): omitting it silently leaves the previous graph active → wrong-graph execution. *SIT F5*
- **H15** — One corrupt template poisons the whole template surface: list/show/suggestions throw TEMPLATE_INVALID naming the wrong target (template.ts:218-219, 295). *SIT F6*
- **H16** — landNode lost-update race, verified: read-mutate-rewrite of trace.jsonl with nothing enforcing the "single-writer" assumption; concurrent `gk run node` lines silently discarded (ledger.ts:260-287). *EL F1*
- **H17** — `.index` is a dual-schema, code-orphaned log: two writers (store.ts:81-92 + cursor hook), zero readers in src; invalidate doesn't append; the skill doc falsely calls it the report's source. *EL F2; ES E5; SRE#10 (reads it)*
- **H18** — marker.md is a hand-rolled KV store: naive `${k}: ${v}` interpolation lets `: `/newline in `--note` silently destroy all provenance with exit 0 (marker.ts:35-50); overwrite-in-place loses history; invalidate regex-failure no-ops into nested `---` blocks. *ES E3; EL F3*
- **H19** — `evidence add --node` parsed then silently discarded (evidence.ts:27, 44-57): producing-node provenance unstampable; report's node line unreachable; the unit test passes the flag but never asserts it. *ES E2; CLI F5.6*
- **H20** — Three truth models for the same evidence: report blind to run lineage (`foreign` dead in buildViews, report.ts:20-25,59), status gates without strict, post-hoc gate silently passes foreign stamps — phase-dependent verdicts. *ES E1; ES E4 (strict facet); SRE#4*
- **H21** — gk-brainstorm teaches a dead constraint key `assigned_only` (SKILL.md:29): validate passes clean, zero src hits, compiler tolerates unknown keys — silent false enforcement. *SB F1*
- **H22** — gk-eval's memory/both gate modes documented but with no execution path: `scoreMemory` reachable only via repo-internal golden replay; `bun run eval:memory` reads repo-only fixtures; CLI registers work_product only (gate.ts:69). *SRE#1*
- **H23** — `gk gate` refuses to score on unrelated graph findings (gate.ts:120-124): a typo elsewhere turns "verdict: BLOCK" into an opaque validation dump at verdict time. *SRE#2*
- **H24** — `freshness: strict` unpassable in non-git projects, with a gaslighting remediation hint ("write evidence via `gk evidence add`" — just done) (fingerprint.ts:25-27; marker.ts:71; gate.ts:78-81). *SRE#3*
- **H25** — Consolidation output is 87.5% evidence-cooccurrence pair-noise (360 pattern files from 25 runs; actionable entries 2.5%); the ≥3-runs threshold is trivially crossed in any real repo. *MEM F1*
- **H26** — Recall delivers near-zero value as shipped: no salience discrimination, linked=0; PPR expansion dead in practice (fires only when 0<hits<k and BM25 always matches); near-complete links graph spreads mass uniformly. *MEM F2; MEM F5*
- **H27** — Re-consolidation destroys reinforcement/expiry state: use_count/last_used_at wiped, expired resurrected, created_at reset (consolidate.ts:128-187); since gk-execute mandates consolidate after every run end, the ACT-R anti-decay mechanism is falsified in the documented flow. *MEM F3*
- **H28** — src/cbm is 391 LOC serving an unpublished backend ("can't work" per its own comment): 6 CLI subcommands (`graph index/search/ask/trace/query`, `memory index`) hard-fail CBM_UNAVAILABLE on every install; re-implements an integration the platform's MCP already provides. *MEM F4*
- **H29** — OpenCode agent dir `agent/` (singular) contradicts current OpenCode docs (`agents/`, plural) (registry.ts:30; validate.ts:30; gen-kits.ts:226): if singular is no longer read, the entire opencode kit's agents are undiscoverable; could not runtime-verify. (source severity MED-HIGH). *EXT F2*

### MEDIUM
- **M1** — Two parallel error protocols: typed GraphKitError vs `CODE: string` re-parsed by regex (run.ts:55-59); six hand-rolled zod formatters; three graph loaders with divergent errors. *CLI F4; CS#9*
- **M2** — Six overlapping command clusters: init vs new; graph new vs materialize vs switch; status/run status/run analyze/suggest; memory index vs graph index (same verb, opposite stores); run take positional vs `--from` contradiction; evidence `--node` (→H19). *CLI F5*
- **M3** — `models` inverts the dispatch grammar (`gk <target> <action>`): 5 leaves × set/reset for one config file. *CLI F6*
- **M4** — Run-pointer protocol crash/concurrency windows: 3 stamp files, 2 identity formats, no fsync/temp+rename; concurrent startRun same-timestamp race deletes the winner's dir; endRun/appendNode/take windows corrupt index.jsonl counts permanently. *EL F5; EL F6*
- **M5** — `evidence add` IO: 3 git subprocesses + O(dirty-tree) hashing on every add/report/gate/start/resume; untracked scratch flips fingerprint → spurious stale cascade. *EL F4*
- **M6** — `template pack` accepts never-materializable templates (no superRefine at pack, template.ts:79-110): literal `{{foo}}` packs ok, fails at materialize. *SIT F7*
- **M7** — `pack --input` demands a dummy positional it then ignores; `--name` vs internal `metadata.name` can silently diverge. *SIT F9*
- **M8** — Skills reference surface that doesn't exist: `init-graph` CLI (SIT F8); `visualize --ascii/--svg/--excalidraw` (SVV F3); gk-status's `current.json` step + `{name}-result.json` + per-node ✓/○/✗ (ES E8); gk-eval's `.index` read + `{run-id}-eval.md` write (SRE#10); repo-internal `scripts/`+`src/` paths in deployed kits (SRE#7); PASS-payload text no command emits + "fails fast" wrong (SVV F4); emoji icons / SVG-opens-browser / 1.2 ms claims (SVV F5).
- **M9** — gk-brainstorm edits the legacy path init-graph abandoned (hardcoded `graph.yaml`), forking the session graph; no validate loop, no severity triage, per-decision in-place rewrites. *SB F2 (file-model, also cited H2/H3); SB F3*
- **M10** — `gk suggest` empty on fresh projects, no empty-case behavior: dead first step on exactly the complained-about path. *SB F4*
- **M11** — `gk graph inspect custom` → `config_keys: []`: the designated config-discovery command dead-ends on the topology every hand-authored graph uses. *SB F5*
- **M12** — Three loop idioms across six gallery templates (node.loop vs top-level loops[] vs none) — the authoring reference teaches three syntaxes for one concept. *GAL F4*
- **M13** — cook-plan has no declared channel for its goal (no parameters, no inputs; `--input goal=` rejected). *GAL F6*
- **M14** — Model-tier defaults are snapshot product names baked into generated prose (Grok 4.5 / gpt-5.4 / dot-spelled Anthropic ids), two spellings per host, and the pinning test defends the rot. *EXT F3*
- **M15** — Target knowledge lives in 3+ unsynchronized tables (registry, gen-kits HOSTS, validate's hardcoded ladder) + AGENT_META duplicating _core prose; H5/H6 are direct descendants of this shape. *EXT F7*
- **M16** — Memory lifecycle is a 4-command manual choreography across three surfaces with no post-run hook; consolidate thresholds are private constants, so first-run recall returns an unexplained empty store. *MEM F6; SRE#5*
- **M17** — Decay/reinforcement engine lives in the CLI layer (memory.ts:76-219, 144 lines of domain logic in the arg-parsing file); touchMemory full store walk ×k per recall. *MEM F7*
- **M18** — Two decay models over one store sharing only HALF_LIFE_DAYS: salience-ranked-top and ACT-R-expired can disagree. *MEM F8*
- **M19** — Five hand-rolled similarity/co-occurrence substrates implement one idea (patterns/links/jaccard/BM25/PPR). *MEM F5*
- **M20** — Compiler imports CLI (validate.ts:4 imports topoWaves from cli/graph-waves.js): dependency direction inverted; levelization mis-homed. *CS#8*
- **M21** — validateGraph mixes pure shape checks with environment probes, forcing the hand-maintained validateDerivedGraph fork (resume.ts:234-242). *CS#7*
- **M22** — `gk run end` doesn't enforce the graph's own contract: exits 0 `merged` with 1/3 nodes and 0/1 required evidence; gate invoked only by agent discipline. *UX F4*
- **M23** — Three names per node (node id / `agent:` field / materialized `gk-<node>`) threaded by hand; nothing validates the recorded agent matches the materialized one. *UX F5*
- **M24** — Evidence ceremony is 2N steps plus a prose-enforced path convention; no record-time cross-check between trace `evidence[]` and marker.node. *UX F6; EL F9*
- **M25** — Node-declared non-required evidence keys stampable but invisible to report and gate (store.ts:30-33 vs report.ts:31). *ES E6*
- **M26** — Legacy compile surface survives in 4 carriers (`gk compile`, emitter pipeline, claude gk-run/gk-compile skills, `workflowTool` flag) while all shipped prose says "no compilation" — two execution stories ship; only one is real. *EXT F4*

### LOW
- **L1** — Empty-string sentinel defaults produce prompt litter ("Focus theme: . Cutoff: ."); schema forces optional⇒default with no conditional-omission story. *SIT F11; GAL F7*
- **L2** — `recommendations.agents` duplicates `nodes[].agent` verbatim; recommended skills don't ship with the kit. *GAL F8*
- **L3** — Version provenance skew (installed 0.3.34 / contract 0.3.33 / repo 0.3.0); `KitTarget` stale 2-of-5; `fable` tier unreachable in AgentMeta union. *EXT F10; SIT F10; SVV F9; ES note; SRE/MEM/GAL headers*
- **L4** — init-graph doc drift: gallery list stale (4 of 6), description "required" vs schema-optional, collision-suffix claim packaged-path-only, unmarked raw-token `--target pi` substitution. *SIT F10*
- **L5** — `shadowed` flag semantics wrong/incomplete (project→ignores gallery; global→hardcoded false). *SIT F13*
- **L6** — No cross-namespace hint: TEMPLATE_NOT_FOUND for `diamond` doesn't mention `gk graph new diamond`. *SIT F12*
- **L7** — dispatch.jsonl/trace.jsonl split justified but weakly enforced (`--pid` optional; pid-reuse false positives). *EL F7*
- **L8** — resumeChain walk duplicated inline in run.ts:404-415; shapes already diverged. *EL F8*
- **L9** — trace `evidence[]` vs marker.node never reconciled at record time (accepted silently). *EL F9*
- **L10** — Absolute evidence paths mangled, not rejected (`join(cwd, "/tmp/x")` → `<cwd>/tmp/x`). *ES E7*
- **L11** — `renderMarkdown` delivers ~40% of the gk-evidence skill's promised report layout; every consumer re-implements the rest. *ES E11*
- **L12** — 19-flag shared option bag on `run` (every leaf sees every flag; `--status` = 3 enums); flag-dump help; grammar only in example strings. *CLI F7; UX F8*
- **L13** — Two help formats per group (cac vs curated console.log), hand-synced, already drifting. *CLI F9*
- **L14** — Fire-and-forget async IIFEs in graph CBM leaves can escape error handling. *CLI F8*
- **L15** — Guardrail asymmetry: brainstorm changes bindings/models/overwrites with none of init-graph's approval gates. *SB F6*
- **L16** — Vague terminal handoff: brainstorm's "suggesting `execute`" names no command. *SB F7*
- **L17** — Misleading recovery hints: GRAPH_FILE_NOT_FOUND suggests `graph new` even with a session graph active; id-rejection gives no hint. *UX F9; SIT F12*
- **L18** — SCHEMA_INVALID messages don't help agents fix the doc (empty path, no did-you-mean). *CS#10*
- **L19** — graph.ts 1077-line god file (~515 lines embedded YAML + 13-branch chain); run.ts same pattern. *CS#11*
- **L20** — Two exported `materializeTemplate`s, same name, different semantics (template.schema.ts:211 vs template.ts:278). *CS#12; GAL SOLID; SIT SOLID*
- **L21** — jev.ts resolves API keys from `~/.9router/db/data.sqlite` — dogfood-local fallback in shipped kit code; zero tests. *EXT F6*
- **L22** — Store meta-state sprawl: 6 sidecar files; `.recall-log.jsonl` hardcodes `injected:true`; `.last-index` watermark nothing reads; an external hooks plugin owns the `.graphkit/memory/.index` freshness watermark. *MEM F9; SRE#9*
- **L23** — Recall is not read-only: touch rewrites frontmatter → BM25 doc length changes → scores drift after first reinforcement (3.9117 → 3.7921 measured). *SRE#8*
- **L24** — Salience vocabulary drift between plain and explain recall; linked hits appended by admission, not score order. *SRE#11*
- **L25** — Inline `require("node:fs")` in an ESM tree (template.ts:137, 373). *SIT F14*

### INFO
- **I1** — Latency exonerated: 60–250 ms/call; < 5 s CLI per flow; friction is procedural — command count is the metric. *EL F10; UX F10*
- **I2** — Kit materialization pipeline verified clean end-to-end (gen-kits staged swap + both `--check` gates → installKit care → node-agents materializer → live omp discovery; pi smoke passed). *EXT F8*
- **I3** — gk-subagent retained-rationale verified: uniquely provides wall-clock kill + TIMEOUT marker + dispatch-intent records; shrink schema toward {agent, objective, timeout_ms, node, attempt}; dispatch() has zero direct tests. *EXT F5*
- **I4** — Wave computation duplicated inside validate (loop_contiguous memoized DFS vs topoWaves). *CS#14*
- **I5** — Findings carry no machine-actionable fix data; skill maps 4 of 22 check names; severity inversion trap (`"warning"` typo silently blocks). *SVV F8*
- **I6** — gk-brainstorm is ~80% re-implementation of the host brainstorming skill + init-graph steps at lower rigor; 6 byte-identical kit copies synced by manual mirror. *SB F8*
- **I7** — cwd-relative validate noise: refs-exist blocking findings appear/disappear by directory. *SB F9*
- **I8** — Gate-as-node friction: the gate agent must know 4 undocumented facts (whole-graph pre-validation, ADR-002 basename mapping, strict semantics, require_landed comparison). *SRE#12*

## 4. SOLID verdict

| Principle | Verdict | Strongest evidence |
|---|---|---|
| **S** (SRP) | Violated at multiple layers | Execution planner + curator interleave inline in CLI, admitted duplicate of `.workflow.js` semantics (graph.ts:821-963, comment at 843-845) — CS#3, SVV SRP, CLI SRP · decay engine in the arg-parsing file (memory.ts:76-219) — MEM F7 · graph.ts 1077-line god-file — CS#11 · src/memory is two subsystems (run ledger vs knowledge store), decay in neither — MEM SOLID · gen-kits = transform+emission+diff+CLI with AGENT_META data-in-code — EXT S · store.ts = policy+transport+ledger-linkage+persistence — EL S · gateGraph merges 4 concerns — SRE S · materializeTemplate spans 7 concerns — SIT SRP |
| **O** (OCP) | Violated everywhere that matters | Add a leaf: 2–3 edit sites (registry + if-chain + hand-synced prose) — CLI OCP, SVV OCP, SIT OCP · add a topology: ≥4 sites — CS OCP · add host #6: ≥8 sites — EXT OCP · new record type: touches 5 files, no event abstraction — EL OCP · new pattern kind: if/else inside consolidate — MEM OCP · `Freshness.foreign` kept as a dead entry for exhaustiveness — ES OCP · `EvalConfig.mode` open enum, exactly one consumer branch — SRE O · template-vs-graph kind-check remembered in one command only — GAL O |
| **L** (LSP) | Violated | Graph identifiers not substitutable across commands (id/path/omission) — UX LSP · models inverts the group grammar; `graph new` breaks the envelope its siblings keep — CLI LSP · two agent-binding implementations non-substitutable — CS LSP · brainstorm violates init-graph's guardrail invariants (approval, inventory check, overwrite protection) — SB LSP · three graph-resolution strategies masquerading as interchangeable coverage surfaces — ES LSP · topology label ≠ documented behavior — GAL L · explain/plain recall vocabularies not substitutable — SRE L |
| **I** (ISP) | Violated in spirit | 19-flag shared bag on `run`; every leaf's interface includes every other's — CLI F7, UX ISP · waves payload 20+ fields vs the 7 its documented consumer needs — SVV ISP, CS ISP · `show` exposes counts where its consumer needs definitions — SIT ISP · TargetDescriptor fat; consumers use slices — EXT I · status hands GateResult wholesale plus a structurally-always-null run — ES ISP · memory = 12 modules + 6 subcommands + 6 sidecars — MEM I · skill-facing recall shape hides validity windows, forcing re-reads — SRE I |
| **D** (DIP) | Root cause of the headline failures | template-layer params never touch graph/run-layer inputs (double entry) — SIT DIP · three graph loaders + two error protocols — CLI D · compiler→cli import — CS#8 · schemas reach up into targets for TIERS — CS D · validate's hardcoded fs ladder vs the registry that owns the knowledge (root of H5/H6) — EXT D, SVV D · status depends on a phantom file convention 30 lines from the ledger API — ES D · evidence⇄memory know each other's internals — EL D · production recall imports its engine from the eval harness; memory⇄eval cycles — MEM D · deployed kits reference repo-internal `scripts/`+`src/` — SRE layering · policy (gate-before-end, stamp-before-gate, dispatch-intent) enforced by agent discipline, not mechanism — UX DIP · skill binds to imagined compiler internals (`assigned_only`) — SB DIP |
| **Duplication** (cross-cutting) | Pervasive | 4× tolerant-JSONL readers — EL I · marker parsing triplicated (gate/report/resume) — EL · resumeChain ×2 — EL F8 · 6 zod formatters — CS#9 · 2 help formats — CLI F9 · topology names in 5 places — SIT SOLID · 6 kit copies — SB F8 · 2 decay models — MEM F8 · 5 similarity substrates — MEM F5 · "is evidence covered" implemented 3× with 3 answers — ES DRY · curator interleave ×2 — SVV SRP |

## 5. Layering map

**Layer-1 — abstract contracts** (stable, singly-owned, testable; every Layer-2 piece is a thin projection):

1. **Event store + projections** — one append-only typed event log (`run.started/ended`, `node.dispatched/traced/landed`, `advisor.fired`, `evidence.stamped/invalidated`, memory lifecycle events) with generated views (trace, `marker.md`, `run.md`, index, status). Grounding: the run ledger and evidence store are already isomorphic (JSONL + mutable view + summary + pointer stamps) — EL merge; land-as-append kills the only read-modify-write — EL F1; one schema/one reader kills `.index` — EL F2, ES E5; marker.md survives as a generated agent-readable view — EL F3, ES; one writer per memory file — MEM F3.
2. **Graph document contract** — one resolver accepting path | session id | active pointer, one discriminated loader (`Graph | GraphTemplate`), immutable session graphs + active pointer with extended reach. Grounding: UX F1, SB F2, SVV F10, ES LSP, GAL O, UX keep.
3. **Planner IR** — `planGraph()` in `compiler/` owning waves + curator interleave + topology semantics (incl. `topology_config`); `waves/agents/ascii/svg` and gate coverage become views over it; `topoWaves` stays the shared seam and moves out of `cli/`. Grounding: CS#3/#4/#13/#14, SVV merge proposal, CLI F2, SVV positive (topoWaves pattern).
4. **Declared-input contract** — one namespace for user-provided values; materialize seeds same-named graph inputs; enforcement exactly once, at start; pack-time schema validation. Grounding: SIT F4/F7, GAL F5/F10, SIT DIP.
5. **Target & binding contract** — one target table (agent dirs, file extensions, model tiers) consumed by validate + node-agents + gen-kits + models; single `agentFileName` rule. Grounding: EXT F1/F7/F9, CS#6, SVV F1.
6. **Diagnostic contract** — one envelope (fail ⇒ exit 1), one error type, one zod-issue formatter emitting `{path, message, hint}`; findings carry severity + machine-usable fix data; superRefine never masked. Grounding: CLI F3/F4, CS#9/F10, SVV F2/F6/F8.
7. **Memory lifecycle contract** — one decay model, one writer module; `run end` auto-chains consolidate + trace; `recall` is the only read entry with explain built in and a hard read-only guarantee for the scoring path. Grounding: MEM F3/F6/F7/F8, SRE#5/#6/#8/#9.
8. **Skill distribution contract** — skills = thin Tier-1 orchestration prose + **generated** Tier-3 references (command tables, parameter contracts, checklists); zero repo-internal paths; one authoring skill with create|refine verbs. Grounding: SIT F1/F8/F10, SB F2/F8, SRE#7, SVV F3/F4, ES E8.

**Layer-2 — detail/implementation** (replaceable):
- CLI verbs as thin projections over L1 (§7 surface).
- Gallery templates as validated data (schema-checked at pack; honest labels; one loop idiom) — GAL.
- gen-kits + installKit + node-agents materializer — verified clean E2E, consumes the target table — EXT F8.
- gk-subagent shrunk to `{agent, objective, timeout_ms, node, attempt}` — EXT F5.
- eval harness — scope per §8.

**Rule the audits support**: Layer-2 may not re-implement Layer-1 logic. Every HIGH except H21 traces to an L1 rule (resolution, validation, identity, input, error, state) being implemented per-command, per-file, or per-skill instead of once.

## 6. Kill / Merge / Keep

### Kill
| Item | Why | Refs |
|---|---|---|
| `current.json` + the kit instruction to hand-write it | nothing writes it; status lies during live runs | CLI F1; ES E4 |
| `src/cbm/` + `graph index/search/ask/trace/query` + `memory index` + `.last-index` | backend cannot install; 6 always-fail commands; platform MCP already provides the integration | MEM F4 |
| `.index` dual-schema log | write-only, two schemas, never fed to views | EL F2; ES E5 |
| `gk compile` + emitter/resolver + claude gk-run/gk-compile extras + `workflowTool` flag | one dead surface, four carriers (pending §8.1) | EXT F4; CS DECIDE |
| evidence-cooccurrence pattern kind | 87.5% of store volume, 0% of recall value | MEM F1 |
| PPR link expansion + links.ts as a retrieval input | measured 0 linked hits; keep at most as curator visualization | MEM F2; MEM F5 |
| gk-brainstorm as a standalone skill | ~80% re-implementation at lower rigor | SB kill |
| gk-eval memory/both doc sections | 0% runnable today | SRE#1 |
| dead keys / ghost commands / fictional files in skills | `assigned_only`; `visualize` verb; `{name}-result.json`; `{run-id}-eval.md`; repo-internal paths | SB F1; SVV F3; ES E8; SRE#10; SRE#7; SIT F8 |
| `init` vs `new` as separate commands | new = mkdir + init | CLI F5.1 |
| models ×5 leaves | grammar inversion; one verb + flags suffices | CLI F6 |
| `run dispatch/land/take/round` as separate paths; `suggest`/`run analyze` as commands | absorbed by run node/resume/status | CLI kill list |
| `graph new`-to-stdout; `graph show`; `memory trace/touch` as user verbs | agent-implemented or automatic side-effects | CLI F5.2; CLI kill list |
| `graph ascii/svg` as execution-adjacent verbs | viz-only; loses role as execution contract | CLI cut list |
| cursor-model-map pinning test; `claude/agents` ladder entry | defends rot; vestigial | EXT F3; EXT F9 |
| decorative `--json` flags | fiction — output format is invariant | SVV F6; ES E10 |
| pack dummy positional; `_core` raw-token substitution; inline `require()` | traps and hidden contracts | SIT F9; SIT cut; SIT F14 |
| inline resumeChain copy; `run.md` timeline duplication; `stampTakeover` as separate file | duplicated/derivable | EL F8; EL kill |
| `evidence report` as a separate command | gate is the report | CLI kill list |

### Merge
| Into | What | Refs |
|---|---|---|
| one event store | evidence store + run ledger (+ projections) | EL merge |
| one scaffold verb | init + new; default target covers `.omp/agents` (kills the two-init dance) | CLI; UX; GAL F2 |
| one creation entry | graph new / template materialize / graph switch → e.g. `materialize --from-topology` or `graph new --save --use`; naming/collision returns to tooling | SIT merge; CLI F5.2 |
| one plan call | validate + waves + agents → `gk graph plan` (one validateGraph pass); `run start` returns `{run, waves, agents_dir}` | SVV merge; CLI F2 |
| one read surface | status / run status / run analyze / suggest, `.active`-derived; status+evidence ≈70% overlap → one evidence-core, two thin projections | CLI; ES merge candidate |
| run end | chains consolidate + trace automatically; `gk memory recall` becomes the only read an agent needs | MEM top-3 |
| `src/memory/lifecycle.ts` | traceMemory + touchMemory out of cli/; one decay model (pick ACT-R); suggest→consolidate with kind→action as data; resume/analyze/loops/ledger → `src/runs/` | MEM merge |
| one target table | registry + gen-kits HOSTS + validate ladder + AGENT_META (derived from _core) | EXT F7 |
| one agent resolver | `agentFileName` single rule; agent-dir resolver shared by validate + node-agents | CS; SVV |
| one error path | `formatZodIssues()` → `{path, message, hint}`; GraphKitError everywhere | CS#9; CLI F4 |
| one authoring skill | brainstorm → refine mode: active session graph, batched decisions, one consolidated diff, approval, new session version + switch, named execute handoff | SB merge spec |
| one recall payload | `--json` recall includes explain's matched_terms + rejected-with-reason summary | SRE merge |
| one loop idiom | collapse node.loop vs top-level loops[] | GAL F4 |
| one declared-input layer | parameters + inputs unified, single enforcement point | SIT F4; GAL |
| derivation | `recommendations.agents` generated from `nodes[].agent` | GAL F8 |
| one name | CLI `materializeTemplate` → `materializeSessionGraph` | CS#12 |
| single-step record | dispatch+node → one upsert; evidence write+add → one command (`evidence write --key --node` or `run node --evidence-file`), 2N→N | UX |
| one param-discovery surface | `show` returns full parameters + recommendations; MISSING_PARAMS carries descriptions/defaults | SIT merge |
| the CLI as single source | topology names/contract served by `graph topologies/inspect`, not inlined in prose; usage/help derived from one registry | SIT; CLI F9 |

### Keep
| Item | Why | Refs |
|---|---|---|
| atomic write + temp cleanup; `closeMatches`; MISSING_PARAMS-before-write; session immutability + `-2` collision naming; project>global>gallery ladder (as ONE implementation) | verified good | SIT keep |
| GraphTemplateSchema + strict param-contract refinements (also run at pack) | clean, well-refined | SIT; CS keep |
| `.active` wx-exclusivity + dangling-pointer recovery + take path | genuinely good crash UX | EL keep |
| fingerprint + content-addressed artifacts + `.graphkit/` exclusion (add caching/scoping) | well-scoped, honest | EL F4; ES keep |
| ADR-002 key→`<evidence_dir>/<k>.md` gate contract | deterministic, parser-free | ES; SRE |
| invalidate semantics (superseded ≡ missing agreement) | keep | ES |
| `resolveGraph` | promote to shared CLI util (fixes half of E4) | ES fix |
| dispatch/trace intent-vs-outcome distinction (as event types); tolerant JSONL readers; `marker.md` as generated agent-readable view | sound design | EL keep |
| gen-kits staged swap + both `--check` gates; node-agents materializer; installKit care | verified E2E | EXT F8 |
| gk-subagent timeout/kill/intent semantics (shrunk schema) | unique capability, verified rationale | EXT F5 |
| `.strict()` schema default; Finding severity model; warnings-ride-ok; exhaustiveness-keyed TOPOLOGY_TABLE | correct posture | CS keep |
| `topoWaves` shared levelization (extend the pattern to agent dirs) | renderers cannot disagree with the executor | CS; SVV positive |
| store.ts primitives; deterministic no-model consolidation approach (fix field-merge + co-occurrence flood); index.md; `.trace-log` | right approach, wrong fields | MEM keep |
| recall `--explain` lens + render-recall; verified side-effect-free explain guarantee; PPR rejected-reasons | the only honest debug surface | MEM keep; SRE keep |
| single Result envelope + fail⇒exit-1 | the rule to enforce everywhere | SVV; CLI F6 |
| run ledger + resume/take + RUN_ACTIVE guard; gate + fingerprints (make `end` invoke it when `required_keys` exist); immutable session graphs + active pointer (extend reach); `materialize --use` one-shot; waves payload as authoritative order | core value | UX keep |
| validate-before-edit ordering; suggest folding (with empty-case); model-tiering and loop guidance (post-fix) | salvageable skill content | SB keep |
| cook-plan (authoring reference), bench-eval (only true fan-out), refactor-module (post-H1 fix) | honest templates | GAL keep |

## 7. Proposed minimal surface

**Reconciliation.** cli-surface proposes 10 verbs (56 paths → 10; common path 13 → ~7 invocations across 5 namespaces). ux-journey independently proposes a one-shot `gk up` (init → materialize → validate → run start → agents; 9 → 1–2 cold start) plus `run node --evidence-file`. These compose rather than conflict: **run-start fusion delivers most of `gk up`'s value for an initialized project; `gk up` removes the cold-start ceremony — which is exactly the complained-about path.** Recommendation: the 10-verb base + `gk up` as a thin orchestrating entry over them (not a new subsystem).

| Verb | Absorbs | Notes (source) |
|---|---|---|
| `gk init [--dir] [--target] [--force]` | init, new; default target covers `.omp/agents` | kills the two-init dance (CLI; UX; GAL F2) |
| `gk up [<template\|topology>] [--params J] [--input k=v…] [--as ID]` | cold start: init → new → check → run start → graph agents | returns `{run, waves, agents_dir}` (UX add; alternatives below) |
| `gk new <template\|topology> [--params J] [--as ID] [--list]` | graph new/inspect/topologies, template materialize/list/show, graph switch; writes + activates; `--list` enumerates both namespaces | (CLI; SIT merge) |
| `gk check [file]` | validate — thin read-only form of the same pipeline | (CLI; SVV) |
| `gk run start\|node\|end\|resume` | run start/dispatch/node/land/end/resume/take/round; **start returns `{run, waves, agents_dir}` in one call**; node absorbs dispatch/land/round + `--evidence-file` (2N→N); `resume --take` | (CLI F2; UX; EL) |
| `gk status [--evidence] [--suggestions]` | status, run status, run analyze, suggest; `.active`-derived, one read surface | fixes H4 (CLI; ES E4) |
| `gk gate [file] [--html]` | gate + evidence report; `--html` writes and returns the path **in the envelope**; `run end` invokes gate when `required_keys` exist | (CLI; ES E9; UX F4) |
| `gk evidence add\|invalidate [--node]` | evidence add/invalidate; **wire `--node` or cut it**; UX alternative: `--evidence-file` on run node | (ES E2; UX F6; EL F9) |
| `gk ask <query> [--explain]` | memory recall/touch, explain built in, reinforcement inside. **CBM half dies with H28** — code Q&A stays external MCP | (CLI; SRE#6; MEM F4) |
| `gk models [target] [--map k=v] [--reset]` | models ×5; grammar normalized to verb + flags | (CLI F6; EXT F3) |

Optional 11th: `gk draw [file] [--svg]` — viz-only (absorbs graph ascii/svg) (CLI cut list).
Dropped: `compile` (pending §8.1), `graph show`, memory trace/touch/index as user verbs, suggest/analyze as commands.

**Adjustments to cli-surface's original table from other audits**: `ask` loses the CBM verbs (MEM F4); the `index` verb shrinks to a memory-store rebuild or disappears (MEM F4); `compile` decision deferred (§8.1); `check` documented as the thin form of run-start's validation, so PASS and dispatch-prep can never disagree (SVV F1).

**Alternatives**: (a) no `gk up` — `init` auto-covers agents and start-fusion alone gets informed users to ~7 calls (CLI's number); (b) `gk up` as the only documented entry for the native flow, verbs as escape hatches (UX's number); (c) recommended: `gk up` for cold start, fused `run start` for warm start.

**Net effect against measured baselines**: 13 paths / 6 namespaces → ~7 calls / 5 namespaces (CLI) · 9 → 1–2 cold start (UX) · 3N+K+3 → N+K+3 (EL) · 5 → 1–2 validate-prep round trips (SVV) · evidence 2N → N (UX) · zero skill-only secrets once `run start` owns waves+agents and `status` owns orientation (CLI).

## 8. Open questions for the user

1. **One runtime or two?** If the Claude Workflow-tool path is dead, kill `gk compile` + emitter/resolver + the 8 kit `.workflow.js` + gk-run/gk-compile skills; if kept, topology semantics need one shared definition both runtimes consume — today `topology:` promises behavior the default runtime never delivers. *(CS DECIDE; EXT F4; CS#4)*
2. **Which host targets are actually supported?** pi + claude verified working (EXT F8); codex hard-blocked by the binding bug (EXT F1); opencode dir contract unverified and possibly wrong (EXT F2); cursor tier defaults rotting (EXT F3). Freeze to pi+claude, or fix the target table for all five?
3. **Memory: product or experiment?** Even after MEM's top-3 fixes, recall value was near-zero as shipped (MEM F1/F2) and nothing can seed content memories (SRE#5). Keep-and-fix, or move memory to a sidecar / harness-native memory and shrink gk to run + evidence + gate?
4. **CBM / code-structure Q&A**: confirm killing the spawn-and-404 bridge in favor of the external codebase-memory MCP the platform already mounts? *(MEM F4)*
5. **Single-writer assumption**: is concurrent multi-agent landing a real requirement? It decides append-only JSONL vs sqlite for the event store (EL prefers JSONL unless multi-writer becomes real; the H16 race exists only because the assumption is unenforced).
6. **Skill generation policy**: hand-maintained 6-copy mirror + raw-token substitution (SB F8, SIT F10) vs build-time generation into kits — how much prose may exist ungenerated?
7. **Gallery status**: product surface (then fix audit-pr/dream labels and the cook-plan goal channel per GAL) or internal scaffolding (then cut to the 3 honest templates)?
8. **Envelope**: always-JSON and drop the decorative `--json` flags (ES E10, SVV F6), or invest in a human mode?
9. **Strictness defaults**: strict-freshness semantics outside git — drop to no-op-with-warning, or make markers self-contained (hash evidence bytes, not repo state)? *(SRE#3)* And gate-before-end: mechanism in `run end` (UX F4) or still agent discipline?
10. **Release hygiene**: the 0.3.0 / 0.3.33 / 0.3.34 version skew (EXT F10; SIT F10; SVV F9; ES note) — single-source versioning in re-architecture scope?
