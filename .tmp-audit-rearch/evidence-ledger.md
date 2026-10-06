# evidence-ledger audit — src/evidence/* + src/memory/ledger.ts + src/cli/commands/run.ts

Scope: criteria/fingerprint/marker/report/store.ts, ledger.ts, run.ts, plus touchpoints gate.ts, resume.ts, evidence.ts, kits/cursor/hooks/evidence-persist.cjs. Empirical runs in /tmp/ev-audit (scratch, cleaned state). gk 0.3.34 installed; repo source read directly.

## Findings

### F1 — HIGH — landNode lost-update race (verified) — src/memory/ledger.ts:260-287
`landNode` reads trace.jsonl, mutates one line, rewrites the whole file. Comment claims "single-writer run makes this safe" (ledger.ts:261-262) but nothing enforces single-writer: waves dispatch parallel subagents; orchestrator may land a node while another agent's `gk run node` is mid-flight.
Evidence: in scratch repo, snapshot trace.jsonl → real `gk run node` appended line 31 → wrote snapshot back (exactly landNode's write) → line 31 gone. Verified loss, 0 grep hits for the appended notes.
Also landNode discards concurrent lines silently — no error, poisoned audit trail. Fix in re-architecture: land = append a `node.landed` event; "latest wins" resolved at read. Kills the only read-modify-write in the system.

### F2 — HIGH — `.index` is a dual-schema, code-orphaned log — src/evidence/store.ts:81-92, kits/cursor/hooks/evidence-persist.cjs:19-21
Two writers, two line schemas, one file (`<evidence_dir>/.index`): `addEvidence` appends rich {file,at,key,node,artifact,sha256}; the Cursor kit PostToolUse hook appends thin {file,at} for any agent Write into evidence dir. No gk code reads `.index` (grep: only writer is store.ts; readers are skill docs telling agents to read it). Meanwhile the authoritative per-key state is marker.md — overwritten in place, history lost unless you squint at .index. A single append-only evidence log (or table) of record with marker.md as a generated view is strictly better: atomic appends, full history, one schema, one parse per gate/report.

### F3 — HIGH — marker frontmatter is a hand-rolled KV store doing sqlite's job badly — src/evidence/marker.ts:35-65, src/cli/commands/evidence.ts:100-121
Marker = latest-record-per-key, YAML-frontmatter row. Costs: per-key file read + regex + YAML.parse on every gate/report/resume check (gate.ts:56-57, report.ts:45-46, resume.ts:166); overwrite-in-place (store.ts:76-79) loses prior stamps (sha-addressed artifacts survive, metadata doesn't); `evidence invalidate` preserves body by regex-strip (evidence.ts:114) — if the frontmatter regex fails, replace no-ops and renderMarker prepends nested `---` blocks. JSONL/sqlite gives append + last-wins + supersede-as-event + O(1) lookups. Keep marker.md only as agent-readable rendered view (it IS greppable/readable by agents — that's its one real job).

### F4 — MEDIUM — evidence add IO: 3 git subprocesses + O(dirty-tree) reads + full artifact read — src/evidence/store.ts:52-92, src/evidence/fingerprint.ts:25-46
One `gk evidence add` = readFileSync(whole artifact, up to 10MB default) for sha256; fingerprint spawns `git rev-parse`, `git ls-files -m`, `git ls-files -o` and stat+read+sha256 every dirty/untracked non-ignored file ≤1MiB. Measured (M4, warm cache): ~94ms to hash 128MB/2000 files + 16ms ls-files; negligible on small trees, but O(dirty bytes) and runs on EVERY of: evidence add, evidence report, gate, run start, resume reconcile. Consequence, not just perf: any untracked scratch file (logs, screenshots outside .graphkit) flips fingerprint_tree mid-run → every earlier marker goes "stale" spuriously. fingerprint is scoped to exclude `.graphkit/` only. Cache by (path,size,mtime) or fingerprint only graph-declared paths.

### F5 — MEDIUM — `.active` pointer protocol: 3 stamp files, 2 identity formats, no fsync — src/memory/ledger.ts:51-83,118-191, src/store/index.ts:10-11
`.graphkit/runs/.active` (absolute path), `.graphkit/runs/.takeover` (run id), `.graphkit/active` (session-graph id) — three pointer files, two conventions, no transaction. `wx`-flag write (ledger.ts:182) is exclusive-create, not crash-atomic (comment "atomic: no check-then-write window" overstates: no fsync, no temp+rename anywhere in src). Crash mid-write → empty (treated as no run) or partial path (dangling → recoverable via `take`; auto-clear exists, startRun:126-130). Concurrent same-timestamp startRun: both-pass-existsSync window → both mkdir the same dir (recursive:true no-errors), loser's cleanup rmSync (ledger.ts:184) deletes WINNER's dir + .active dangles. Nanosecond window, but the design (id allocation by dir-existence probing) invites it.

### F6 — MEDIUM — endRun/appendNode/take windows — src/memory/ledger.ts:193-204,334-366
- `endRun` reads .active, computes summary from trace, appends index.jsonl, rmSync .active last. An appendNode that read .active before the rm appends into a closed run → trace line after summary → node_count in index.jsonl wrong forever (index is never recomputed).
- Two concurrent `end`s: both can pass the activeRun check → duplicate index.jsonl lines for one run. My test hit the safe interleave (one got NO_ACTIVE_RUN); window is real (existsSync→rmSync spans readTrace+JSON+append, ~ms).
- `take` clears .active while an in-flight node record can still land in the dead run's trace (orphan line, silently accepted — appendNode throws only if pointer already gone).
No fsync: JSONL readers skip torn tails (good pairing), but meta.json truncation on crash → readRunMeta throws RESUME_RUN_NOT_FOUND for an existing run — misleading code for a corrupt-file condition.

### F7 — LOW — dispatch.jsonl vs trace.jsonl split: justified intent/outcome distinction, weak enforcement — src/memory/ledger.ts:227-258, src/cli/commands/run.ts:103-123
Split exists so resume can distinguish "dispatched but quiet" from "never dispatched" — sound. Weaknesses: `--pid` optional → dispatch without pid is unliveness-checkable, `take` unblocks while agent may still run; pid reuse makes liveDispatchPids false-positive (kill(-0)-style check on a recycled pid blocks takeover); reconciliation joins two files by node id (resume.ts:209-214). As event types in one log (dispatched/node.recorded/node.landed) the split survives with one file and no join.

### F8 — LOW — resumeChain: cheap but duplicated — src/memory/resume.ts:116-129, src/cli/commands/run.ts:404-415
O(chain) meta.json reads, cycle-guarded — fine for realistic chains. Real issue: run.ts `status` re-implements the identical walk inline instead of calling resumeChain — two copies to keep in sync (already diverged in shape: status builds array, resumeChain builds Set). 

### F9 — LOW — trace evidence[] vs marker.node never reconciled — src/cli/commands/run.ts:246-261, src/memory/resume.ts:161-173
`run node --evidence k1,k2` accepts keys with no stamped artifact (verified: recorded `--evidence art` before any `evidence add` succeeded — accepted silently). Marker.node is optional and unvalidated against trace lines. Mismatch surfaces only at gate (missing marker) or resume (evidenceOnDisk check). Record-time cross-check (warn: "key stamped? run gk evidence add") would catch agent errors one step earlier — cheap UX win.

### F10 — INFO — measured CLI per-call cost — /tmp/ev-audit timings
run start 114/90ms; run node 74ms; evidence add 99ms; evidence report 89ms; run end 88ms; gate 80ms; run status 66ms. ~60-70ms is node startup + YAML+Zod graph parse; fingerprint adds ~110ms per 128MB dirty. Per-call latency is NOT the friction — command count is (see Friction-log). A batch verb (`gk run record-node` doing dispatch+node+evidence+land atomically) or a long-lived daemon would collapse it.

## Friction-log (init → execute, ledger/evidence surface)
1. `gk run start --graph X --json` — graph must be fully schema-valid (first minimal graph rejected: SCHEMA_INVALID demands topology, agent, objective, rejects `description`) — agent must know full node schema up front; error text is good.
2. (input enforcement) `--input k=v` required if graph.inputs declare — MISSING_INPUTS aborts start.
3. Per node (×N): `gk run dispatch <id> [--attempt --via --pid]` → wait for agent → `gk run node <id> --status ok|fail|skipped|challenge [--evidence --duration-ms --notes --attempt --wave --agent --model]` → after integration `gk run land <id> --commit <sha>` (land refuses non-ok latest, BAD_COMMIT on non-hex). 3 calls minimum per node; land requires a real commit sha, so integration must precede landing.
4. Per evidence key (×K): `gk evidence add <file> --key <k> [--node --note]` — key must be pre-declared (EVIDENCE_KEY_NOT_DECLARED otherwise); active run optional but stamping outside one forfeits lineage (run_id null → never "foreign", never chain-satisfiable).
5. `gk gate --json` — optional strictness: `freshness: strict` BLOCKs on stale/unknown/foreign; `require_landed: true` BLOCKs on unlanded ok-lines. Gate recomputes fingerprint + walks lineage every call.
6. `gk run end --status merged|blocked|failed`.
7. Crash/retake path: `gk run take --from <id>` (blocked by live pids) → `gk run start` (consumes .takeover stamp) OR `gk run resume <id> [--from-node --dry-run --force]` (derives + saves a `-resume` session graph, sets active-graph pointer, startRun with resumes link).
Minimum happy path ≈ 3N + K + 3 CLI invocations, each a fresh node process. Every step is a state-machine edge that can fail with its own coded error (RUN_ACTIVE, NO_ACTIVE_RUN, EVIDENCE_KEY_NOT_DECLARED, LAND_NOT_OK, TAKEOVER_BLOCKED, MISSING_INPUTS, RESUME_GRAPH_DRIFT…).

## SOLID-lens
- **S**: store.ts mixes policy (limits, key declaration) + transport (hash/copy) + ledger linkage (activeRun×2, store.ts:65 double-call) + persistence (marker+index). run.ts is a 323-line string-matched if-chain — cac idiom, but each subcommand re-implements graph resolution + validation inline.
- **O**: new record type (e.g. eval verdicts) requires touching ledger.ts + run.ts + analyze.ts + patterns.ts + resume.ts — no event abstraction to extend; closed set of file formats.
- **L**: freshness semantics split across modules — staleness lives in marker.ts (fingerprint compare), foreignness lives in gate.ts (lineage compare), report.ts re-derives presentation; `foreign` is dead in buildViews (ponytail comment, report.ts:19) — two overlapping freshness taxonomies computed in different layers.
- **I**: memory/ledger.ts is a fat module (13 exports) — gate/report/resume/analyze each import subsets and re-parse markers independently; four copies of the tolerant-JSONL reader (readTrace/readDispatches/readAdvisorEvents/readRunIndex, ledger.ts:245-332).
- **D**: package-level bidirectional coupling: evidence/store.ts → memory/ledger.ts (activeRun) while memory/ledger.ts + resume.ts + gate.ts → evidence/{fingerprint,marker}.ts. No cycle at module level, but evidence↔memory know each other's internals; an event-store interface would invert both.
- **Duplication**: resumeChain walk duplicated inline (run.ts:404-415); marker-parsing triplicated (gate, report, resume).

## Kill-or-keep
**Kill**: `.index` dual-schema log (fold into evidence events); run.md timeline duplication (endRun rewrites it, appendNode appends it — generated view or drop); inline resumeChain copy; `stampTakeover` as a separate file (a field on .active or a pending-start event).
**Merge**: evidence store + run ledger → one event store. Both are isomorphic today: append-only JSONL + mutable per-entity view (marker.md / run.md) + summary index (index.jsonl / .index) + pointer stamps. Typed records (run.started/ended, node.dispatched/traced/landed, advisor.fired, evidence.stamped/invalidated) + projections give: land-as-append (kills F1), native run_id lineage (kills resumeChain walks), single schema for .index (kills F2), one reader (kills the 4× reader dup). sqlite only if multi-writer becomes a real requirement; otherwise a single JSONL with append-only events is enough and stays agent-readable.
**Keep**: fingerprint (well-scoped, honest null fallbacks — add caching/scoping); .active wx-exclusivity + dangling-pointer recovery (genuinely good crash UX); dispatch/trace intent-vs-outcome distinction (as event types); content-addressed artifact blobs (idempotent adds); tolerant JSONL readers (pair correctly with the no-fsync reality); marker.md as generated agent-facing view (greppable provenance is worth keeping — as a view, not the record).
