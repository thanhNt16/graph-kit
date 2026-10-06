# Evidence & Status surface audit (evidence-status)

Scope: `kits/_core/skills/gk-evidence/SKILL.md`, `kits/_core/skills/gk-status/SKILL.md`, `src/cli/commands/evidence.ts`, `src/cli/commands/status.ts`, `src/evidence/marker.ts`, `src/evidence/report.ts`, `src/evidence/store.ts` (+ supporting: `gate.ts`, `fingerprint.ts`, `criteria.ts`, `ledger.ts`, `output.ts`, `command-registry.ts`).

Method: read all files; exercised `evidence add/invalidate/report`, `status`, `gate`, `run start/end` against a scratch run in `.tmp-audit-rearch/scratch-evst/` (minimal `graph.yaml` declaring evidence; superseded markers; run A→B foreign stamping; `--graph sub/x.yaml` resolution; note-injection; absolute paths; `--html`). Repo CLI exercised via `bun src/index.ts` (gk/0.3.0 repo src); spot-checked installed gk/0.3.34 where noted. All repro commands listed in scratch dir; state left in place.

---

## Findings

### E1 · HIGH · Evidence report is blind to run lineage — report and gate disagree about the same file
- **Where:** `src/evidence/report.ts:20-25` (dead `FRESH_TAG.foreign` + ponytail comment "buildViews never emits foreign"), `report.ts:59` (`freshnessOf` only computes fresh/stale/unknown); contrast `src/cli/commands/gate.ts:44-62,72-77` (GAP-3 lineage check via `resumeChain`).
- **Evidence (repro):** run A stamps `beta`; `run end`; `run start` (run B, no `resumes` link). Same instant:
  - `gk status` → `freshness: {"alpha":"foreign","beta":"foreign"}`, warning *"evidence stamped by a run outside the active run's resumes chain: beta"*, verdict BLOCK.
  - `gk evidence report` → `beta present fresh, provenance: run 20261006-144049-evst · …` — no foreign hint at all.
- **UX/arch impact:** `gk-evidence` SKILL.md instructs the agent to compose the evidence report **from this command only** ("the enumeration and provenance source … do not scan evidence files by hand"). The agent will write "● present · fresh" for evidence the gate blocks as foreign. Two truth models for the same files (see SOLID-lens). The `foreign` badge exists in the report's badge table but is unreachable — dead branch kept "exhaustive" by a ponytail comment.

### E2 · HIGH · `--node <id>` is parsed then silently discarded — producing-node provenance is unstampable
- **Where:** `src/cli/commands/evidence.ts:27` declares `.option("--node <n>", "add: producing node id")`; the `add` branch (`evidence.ts:44-57`) never forwards `opts.node` to `addEvidence`; `src/evidence/store.ts:66,88` therefore write `node: null` to both marker and `.index`.
- **Evidence (repro):** `gk evidence add ev-beta.md --key beta --node b` (space form) and `--node=b` (equals form): exit 0, marker has `key/run_id/fingerprints/ts` but **no `node:` field**. Same through `buildCli()` in-process (rules out shell). Provenance line in report (`report.ts:62` includes `node ${m.node}`) can never fire.
- **UX/arch impact:** SKILL.md promises each view carries "provenance (run, **node**, fingerprint head, ts)" — the node component is a lie. `tests/unit/evidence-cli.test.ts:61` passes `--node probe` but never asserts the marker field, so CI can't catch it. Fix is one line (`node: opts.node ? String(opts.node) : undefined` in the add opts) — or delete the flag; today it's a data-loss trap.

### E3 · HIGH · Marker rendering is naive string interpolation over a YAML parser — any `: ` or newline in `--note` silently destroys all provenance
- **Where:** `src/evidence/marker.ts:35-40` (`renderMarker`: `` `${k}: ${String(meta[k])}` ``) vs `marker.ts:42-50` (`parseMarker`: `YAML.parse`, returns `null` on error). Asymmetric write/read contract.
- **Evidence (repro):** `gk evidence add ev-beta.md --key beta --note "verified: yes"` → marker contains `note: verified: yes` (invalid YAML mapping). `parseMarker` → null → report view becomes `present / freshness unknown / provenance null`; `run_id`, fingerprints, artifact sha all vanish from the report with **exit 0 and no warning**. Gate-side: strict-freshness graphs BLOCK with the misleading warning "unstamped evidence (no fingerprint marker)". Bonus data loss: `invalidate` on such a file hits the `parseMarker null` fallback (`evidence.ts:101-113`) and rewrites frontmatter as just `key` + `superseded`, dropping the unparseable-but-real fields.
- **UX/arch impact:** free-text `--note` is an advertised feature; the corruption is silent and unrecoverable (only the copied artifact file survives). Either YAML-dump the frontmatter or validate the round-trip before writing.

### E4 · MED · `gk status` reads a file nothing writes, and didn't get the F-01 graph-resolution fix
- **Where:** `src/cli/commands/status.ts:26-32` reads `.graphkit/runs/current.json` — grep confirms **no writer exists in src**; `startRun` writes `.graphkit/runs/<id>/meta.json` + `.active` (`ledger.ts:118-191`). And `status.ts:38` hardcodes `loadGraph(join(cwd, "graph.yaml"))` — no `--graph` option, no `activeRunGraph()` fallback, unlike `evidence.ts:18-21` (`resolveGraph`, fixed per audit F-01).
- **Evidence (repro):**
  - Active run → `gk status` → `{"running":true,"run":null,...}` — run name/timestamp never surface. Every run.
  - `run start --graph sub/x.yaml` with no `./graph.yaml`: `gk evidence add` works (resolves the run's recorded graph — F-01 fix confirmed), but `gk status` → `gate_error: "GRAPH_FILE_NOT_FOUND", coverage: null`.
  - Status also calls `gateGraph` **without `strict`** (`status.ts:40`) while `gk gate` honors `graph.evidence.freshness: strict` (`gate.ts:131`) → status can say MERGE where gate says BLOCK on a strict-freshness graph.
- **UX/arch impact:** the one command meant to answer "what's running" reports a null run and can't see runs started outside `./graph.yaml`. status should read run state via the ledger API (`activeRun`/`readRunMeta`) and reuse `resolveGraph`.

### E5 · MED · `.index` is a write-only ledger; the skill doc claims it feeds the report
- **Where:** writers: `store.ts:82-92` and `kits/*/hooks/evidence-persist.cjs`; readers: **none in src** (report reads `.md` files directly, `report.ts:33-46`). `invalidate` (`evidence.ts:88-127`) does not append to it.
- **Evidence (repro):** after add/add/add/add + invalidate, `.index` has 4 entries all `node:null`, no superseded entry; `alpha.md` superseded on disk while `.index` last alpha entry reads as a fresh add.
- **UX/arch impact:** `gk-evidence` SKILL.md line 12 says the report is fed by "the `.index` written by evidence-persist.cjs … do not scan evidence files by hand" — false; an agent trusting the doc greps a stale, node-blind index. Either feed views from the index (and append on invalidate) or delete it.

### E6 · MED · Node-declared non-required evidence keys are stampable but invisible
- **Where:** declaration check `store.ts:30-33` accepts `required_keys ∪ nodes.*.evidence`; enumeration `report.ts:31` maps **`required_keys` only**; gate likewise.
- **Evidence (repro):** node `b2` declares `evidence: [gamma]` (not required): `evidence add --key gamma` succeeds; `evidence report` shows only `alpha,beta`.
- **UX/arch impact:** you can stamp evidence no report will ever surface — provenance black hole. SKILL.md step 1 even tells the agent to read "each node's declared evidence keys", which the CLI never returns.

### E7 · LOW · Absolute paths to evidence files are mangled, not rejected
- **Where:** `evidence.ts:53` `file: join(cwd, String(file))` — `path.join` treats a leading `/` as a segment.
- **Evidence (repro):** `evidence add /tmp/evx.md --key alpha` → `EVIDENCE_FILE_MISSING: File not found: <cwd>/tmp/evx.md` — identical on installed gk/0.3.34 (`…/scratch-evst/tmp/evx.md`). Use `path.resolve` / `isAbsolute`.

### E8 · LOW · `gk-status` SKILL.md references fictional files and output
- **Where:** SKILL.md:12 `.graphkit/runs/{name}-result.json` — zero writers/readers repo-wide (grep). SKILL.md:14 "one line per node with ✓ completed / ○ pending / ✗ failed" — the CLI emits a JSON envelope `{running, run, coverage, gate_error}`; no per-node completion exists anywhere (node completion lives in `runs/<id>/trace.jsonl`, which status never reads).
- **Impact:** the skill's 3-step procedure is impossible as written; agents improvise from `.active` + `meta.json` or fall back to the CLI and show something the doc never described.

### E9 · LOW · `evidence report --html` is a silent write; `outputs.report` is a schema dead-letter
- **Where:** `evidence.ts:72-78` writes `.graphkit/reports/{name}-evidence.html`, emits nothing (exit 0, 0 bytes stdout); path is hardcoded — ignores `graph.outputs.report`. Grep: **no src consumer of `outputs.report`** (default `.graphkit/reports/{name}.md`, `graph.schema.ts:162`) — it exists only as the skill's instruction to the agent.
- **Impact:** user must guess where the HTML went; markdown persistence is entirely the agent's job, undocumented in the CLI.

### E10 · LOW · `--json` is a no-op on evidence/status/gate
- **Where:** `output.ts:18-20` — `emit` always prints the JSON envelope; the `--json` options (`evidence.ts:34`, `status.ts:12`, `gate.ts:115`) do nothing. Cosmetic doc drift, but trains users to type a magic flag.

### E11 · LOW · `renderMarkdown` delivers ~40% of what the skill promises
- **Where:** `report.ts:70-81` — per-criterion sections only. SKILL.md steps 5's header (topology, run timestamp), coverage table (required key × producing node × status × freshness), and verdict line don't exist in the command output; every consumer re-implements them (the skill tells the agent to; `renderHtml` has its own third layout). Producing node is impossible anyway (E2).

### Version skew note
Repo src is gk/0.3.0; installed global is 0.3.34. E7 confirmed on both; E2 confirmed on repo src (global not re-tested — its add path fails earlier on the absolute-path repro). Re-architecture should assume shipped kits lag src.

---

## Friction-log (a user's journey through this surface)

1. Stamp one evidence file with full provenance = **2 commands** (`gk run start` + `gk evidence add f.md --key k`), plus the graph must already declare the key or add fails `EVIDENCE_KEY_NOT_DECLARED`. From a clean directory the full journey is ~5 commands (author graph → `gk validate` → start → add → report).
2. Skip the run and it's 1 command — but the marker gets **no `run_id`**, and gate lineage check exempts `run_id: null` forever (`gate.ts:61`) — hand-stamped evidence is foreign-in-spirit yet passes silently. No hint at add time that a run is recommended.
3. Typing `--node b` does nothing — no error, no marker field, no index field (E2). Users cannot know.
4. Absolute artifact paths fail with a mangled doubled path in the message (E7).
5. Any `:` or newline in `--note` silently nukes all provenance from the report (E3); nothing validates at write time.
6. `evidence report` prints markdown **inside a JSON envelope** (no plain mode); persisting it is manual; `--html` writes to an unannounced path (E9).
7. After `invalidate`, report says "◌ superseded" (good) but `.index` still shows the old add — and the skill told the agent the index is the source of truth (E5).
8. Run started with `--graph sub/x.yaml`: `evidence add/report` work, `status` shows only `gate_error: GRAPH_FILE_NOT_FOUND` with no way to point it at the graph (no flag) — to see coverage you must run `gk gate sub/x.yaml` yourself.
9. Following `gk-status` SKILL.md literally: `current.json` doesn't exist (step 1 half-fails), `{name}-result.json` never exists (step 2 dead), per-node ✓/○/✗ must be invented (step 4).
10. Two commands answer "is evidence covered": `gk status` (no strict, no foreign-in-report) and `gk gate` (strict, lineage) — they can disagree on the same directory.

---

## SOLID-lens

- **SRP:** the `add` branch of `evidence.ts` is the boundary where data is lost — the store knows about `node`, the CLI layer forgets to carry it. Persistence and provenance-enrichment are split across layers with no single owner of "what constitutes a complete stamp".
- **OCP:** `Freshness` was extended with `foreign` (GAP-3) in gate only; the report's `FRESH_TAG: Record<Freshness, string>` forced a dead `foreign` entry to stay exhaustive — the type system says four states, the module computes two. Extending freshness again will drift the same way.
- **LSP:** three graph-resolution strategies masquerade as interchangeable coverage surfaces: `resolveGraph` (evidence: --graph → active-run graph → ./graph.yaml), status (./graph.yaml only), gate (positional or ./graph.yaml). Same input directory, different behavior per command.
- **ISP:** status consumers receive `GateResult` wholesale (manifest with per-file sha256/bytes, unlanded, warnings) plus a `run` field that is structurally always null — a fat payload assembled from pieces status never vets.
- **DIP:** status depends on a file-format convention (`runs/current.json`) instead of the ledger module that owns run state (`activeRun`/`readRunMeta`, 30 lines away) — the dependency inverted into a phantom file.
- **DRY:** the "check evidence" question is implemented three times (gateGraph, buildViews, and both skills' hand-rolled file procedures) with three different answers. `scoreWorkProduct`-vs-trim-length and superseded handling are duplicated with the same intent — the F-01 audit comment in `report.ts:51-53` shows this pattern already bit once.

## Kill-or-keep

**Keep**
- The ADR-002 key→`<evidenceDir>/<k>.md` filename contract (deterministic, parser-free gating) — `gate.ts:15-23`.
- `addEvidence` content-addressed artifact store + fingerprint exclusion of `.graphkit/` (markers can't stale themselves) — `store.ts:52-79`, `fingerprint.ts:31-33`.
- `invalidate` semantics: keep old provenance, add `superseded` note, gate/report agree superseded ≡ missing — `evidence.ts:100-122`, `report.ts:51-58`.
- `resolveGraph` in evidence.ts — promote it to a shared CLI util (status and gate should use it; that fixes half of E4).

**Fix (cheap, high value)**
- Wire `opts.node` through add (E2) — one line; or delete the flag and the doc promise.
- YAML-safe `renderMarker` (YAML.stringify frontmatter) + round-trip self-check (E3).
- buildViews: reuse the gate's lineage check so report freshness matches gate (E1) — collapses FRESH_TAG.foreign from dead to live.
- status: read run state from `activeRun`/`readRunMeta`, use `resolveGraph`, pass `graph.evidence.freshness` through (E4).

**Kill**
- `.index` as-is: delete, or feed it to buildViews and append on invalidate (E5).
- `runs/current.json` read in status.ts (nothing writes it) (E4).
- `{name}-result.json` line in gk-status SKILL.md (E8); rewrite the skill around the actual CLI envelope.
- `--json` options on always-JSON commands (E10) — or implement a human mode; either way stop shipping the fiction.

**Merge candidate (the asked question):** gk-status and gk-evidence overlap ≈70% — both answer "what evidence exists and is it covered", from the same files, with **different truth models** (foreign exists only in gate; superseded badges only in report). Recommendation for the re-architecture: one evidence-core module (marker parse + lineage + views + verdict); keep two thin projections — `gk status` = run lifecycle + one-line coverage verdict, `gk evidence report` = per-criterion provenance detail — both backed by the same views. Collapse the two skills into one "gk evidence" skill with a status section, or make gk-status strictly lifecycle and defer all coverage language to gk-evidence/gate. Do not keep two independent file-scanning paths.
