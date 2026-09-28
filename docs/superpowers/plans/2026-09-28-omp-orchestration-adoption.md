# OMP Orchestration Adoption — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the reliability and contract gaps identified against `OMP-Agent-Orchestration-High-Level-Design.md`: dispatch-intent recording, `landed` lifecycle, stale-run takeover, evidence-stamp enforcement, challenge dispositions, merge-protocol hardening, and a `cook-plan` gallery template.

**Spec:** `docs/superpowers/specs/2026-09-28-omp-orchestration-adoption-design.md` (committed).

**Architecture:** All state stays in the existing JSONL ledger (`src/memory/ledger.ts`). New fields are additive/optional — no migrations. New verbs follow `run.ts`'s string-subcommand dispatch pattern. Skill-contract changes live in `kits/_core/skills/gk-execute/SKILL.md`; host kits regenerate via `bun run gen:kits` — NEVER edit `kits/{claude,cursor,opencode,codex,pi}` directly.

**Tech Stack:** Bun + TypeScript, zod schemas, cac CLI, JSONL ledger.

## Global Constraints

- `kits/_core/` is canonical; regenerate hosts with `bun run gen:kits` after editing.
- Every new `run`/`evidence` leaf MUST be added to `GROUP_SUBCOMMANDS` in `src/cli/command-registry.ts` or `check-cli-parity` fails.
- All errors use the `SCREAMING_SNAKE` code convention (e.g. `RUN_ACTIVE`, `RESUME_RUN_NOT_FOUND`), thrown as `Error`/`GraphKitError` and mapped via `errCode(e)` in `run.ts`.
- Ledger writes are single-line JSONL appends; multi-line files (trace rewrite for `land`) use `writeFileSync` of the full rewritten content.
- Verify: `bun run typecheck`, `bun run lint`, `bun test` — all green before final commit.
- Non-goal: SQLite, adapter layer, native-task timeouts, fencing, mailboxes, reopened runs.

---

### Task 1: Ledger — dispatch intent, `landed`, `attempt`, atomic `.active`

**Files:**
- Modify: `src/memory/ledger.ts` (TraceLine ~line 8-18; startRun `.active` write ~line 113; appendNode ~line 117)
- Test: `tests/unit/run-ledger.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DispatchLine { at: string; node: string; attempt: number | null; via: string; pid: number | null; }
  export function appendDispatch(cwd: string, line: Omit<DispatchLine, "at">, now?: string): { run: string; node: string }
  export function readDispatches(cwd: string, id: string): DispatchLine[]
  export function landNode(cwd: string, node: string, commit: string, now?: string): { run: string; node: string }
  ```
- `TraceLine` gains `attempt?: number` and `landed?: { at: string; commit: string }`.
- `appendNode`'s param type is `Omit<TraceLine, "at">` — new optional fields flow through automatically; CLI passes `attempt`.

- [ ] **Step 1: Failing tests** — add to `run-ledger.test.ts`:

```ts
test("appendDispatch writes dispatch.jsonl; readDispatches round-trips", () => {
  const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-28T10:00:00.000Z");
  appendDispatch(cwd, { node: "build", attempt: 1, via: "task", pid: null });
  appendDispatch(cwd, { node: "build", attempt: 2, via: "extension", pid: 4242 });
  const rows = readDispatches(cwd, id);
  expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
  expect(rows[1].via).toBe("extension");
});

test("appendDispatch without active run fails", () => {
  expect(() => appendDispatch(cwd, { node: "x", attempt: null, via: "task", pid: null }))
    .toThrow(/NO_ACTIVE_RUN/);
});

test("landNode stamps landed on the node's ok line", () => {
  const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-28T10:00:00.000Z");
  appendNode(cwd, { node: "build", wave: 0, agent: null, model: null, status: "ok",
    evidence: ["k"], duration_ms: 1, notes: null });
  landNode(cwd, "build", "abc123");
  const last = readTrace(cwd, id).at(-1)!;
  expect(last.landed?.commit).toBe("abc123");
});

test("landNode rejects a node with no ok trace line", () => {
  startRun(cwd, join(cwd, "graph.yaml"), "2026-09-28T10:00:00.000Z");
  appendNode(cwd, { node: "audit", wave: 0, agent: null, model: null, status: "fail",
    evidence: [], duration_ms: 1, notes: null });
  expect(() => landNode(cwd, "audit", "abc123")).toThrow(/LAND_NOT_OK/);
  expect(() => landNode(cwd, "ghost", "abc123")).toThrow(/LAND_NOT_OK/);
});

test("second startRun while .active exists fails atomically (EEXIST path)", () => {
  startRun(cwd, join(cwd, "graph.yaml"), "2026-09-28T10:00:00.000Z");
  // Simulate a crash: .active left behind, dir exists
  expect(() => startRun(cwd, join(cwd, "graph.yaml"), "2026-09-28T11:00:00.000Z")).toThrow(/RUN_ACTIVE/);
});
```

- [ ] **Step 2:** `bun test tests/unit/run-ledger.test.ts` → FAIL (functions undefined).

- [ ] **Step 3: Implement** in `ledger.ts`:

```ts
// after TraceLine interface — add fields:
//   attempt?: number;
//   landed?: { at: string; commit: string };

export interface DispatchLine {
  at: string;
  node: string;
  attempt: number | null;
  via: string;
  pid: number | null;
}

const dispatchFile = (dir: string) => join(dir, "dispatch.jsonl");

/** Pre-dispatch intent record — written BEFORE launch so a crashed run can
 *  distinguish "dispatched but quiet" from "never dispatched" on resume. */
export function appendDispatch(
  cwd: string,
  line: Omit<DispatchLine, "at">,
  now = new Date().toISOString(),
): { run: string; node: string } {
  const dir = activeRun(cwd);
  if (!dir) throw new Error("NO_ACTIVE_RUN: start a run with `gk run start` before recording dispatches");
  const entry: DispatchLine = { at: now, ...line };
  appendFileSync(dispatchFile(dir), `${JSON.stringify(entry)}\n`);
  return { run: basename(dir), node: line.node };
}

export function readDispatches(cwd: string, id: string): DispatchLine[] {
  const f = dispatchFile(join(runsDir(cwd), id));
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => { try { return [JSON.parse(l) as DispatchLine]; } catch { return []; } });
}

/** Mark the node's last `ok` trace line as integrated ("landed"). Rewrites
 *  trace.jsonl in place — the only multi-line ledger write; single-writer run
 *  makes this safe. */
export function landNode(cwd: string, node: string, commit: string, now = new Date().toISOString()) {
  const dir = activeRun(cwd);
  if (!dir) throw new Error("NO_ACTIVE_RUN: start a run before landing nodes");
  const id = basename(dir);
  const trace = readTrace(cwd, id);
  let idx = -1;
  for (let i = trace.length - 1; i >= 0; i--)
    if (trace[i].node === node && trace[i].status === "ok") { idx = i; break; }
  if (idx < 0) throw new Error(`LAND_NOT_OK: no ok trace line for node "${node}" in run ${id}`);
  trace[idx] = { ...trace[idx], landed: { at: now, commit } };
  writeFileSync(join(dir, "trace.jsonl"), trace.map((t) => JSON.stringify(t)).join("\n") + "\n");
  return { run: id, node };
}
```

In `startRun`, replace `writeFileSync(activeFile(cwd), dir)` with:

```ts
  try {
    writeFileSync(activeFile(cwd), dir, { flag: "wx" }); // atomic: no check-then-write window
  } catch (e) {
    rmSync(dir, { recursive: true, force: true }); // don't orphan the fresh run dir
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`RUN_ACTIVE: run already active at ${activeRun(cwd) ?? "(unreadable .active)"}`);
    throw e;
  }
```

- [ ] **Step 4:** `bun test tests/unit/run-ledger.test.ts` → PASS.
- [ ] **Step 5:** Commit: `feat(ledger): dispatch intent, landed field, atomic .active`

---

### Task 2: Resume — `unresolved` dispatches + judgment carryover

**Files:**
- Modify: `src/memory/resume.ts` (`Reconciliation` interface ~line 65-72, `reconcileRun` ~103, `deriveResumeGraph` ~255, `ResumeResult` ~11-17)
- Test: `tests/unit/run-resume.test.ts`

**Interfaces:**
- Produces: `Reconciliation.unresolved: string[]`; `ResumeResult.unresolved: string[]` (empty array when none). `deriveResumeGraph` appends carryover text to pending node `objective`s — no schema change.

- [ ] **Step 1: Failing tests** — in `run-resume.test.ts` (match its existing fixture style):

```ts
test("dispatched-but-unresolved nodes surface in unresolved, still pending", () => {
  // startRun + appendDispatch(build) + no trace line → resume reconcile
  const rec = reconcileRun(cwd, runId);
  expect(rec.unresolved).toEqual(["build"]);
  expect(rec.pending).toContain("build");
});

test("resolved dispatch does not count as unresolved", () => {
  // dispatch + ok trace line → unresolved empty
});

test("resume carries unadjudicated challenges into pending node objectives", () => {
  // parent: challenge line, no disposition in notes → derived graph objective
  // contains "## Resume context" and the challenge evidence text
});

test("resume carries last advisor event per pending node", () => { /* ... */ });
```

- [ ] **Step 2:** `bun test tests/unit/run-resume.test.ts` → FAIL.

- [ ] **Step 3: Implement:**

In `reconcileRun`, after `pending` is computed:

```ts
  const dispatched = readDispatches(cwd, runId);          // import from ./ledger.js
  const resolved = new Set([...satisfied, ...skippedStatus]);
  for (const line of last.values()) resolved.add(line.node); // any trace line resolves
  const unresolved = [...new Set(dispatched.map((d) => d.node))]
    .filter((n) => !resolved.has(n) && pending.includes(n))
    .sort();
```

Add `unresolved` to the returned `Reconciliation`; thread through `resumeRun` into `ResumeResult` (both return sites ~line 34 and ~57).

In `deriveResumeGraph`, before building `nodes`:

```ts
  // Carryover: judgment state the parent run accumulated. Evidence bytes are
  // replayed as refs below; challenges/advisor diagnoses/steering are prose —
  // append them to the objective so the resumed worker sees them.
  const unadjudicated = new Map<string, TraceLine[]>(); // target → challenges
  for (const line of trace)
    if (line.status === "challenge" && !(line.notes ?? "").includes("disposition="))
      unadjudicated.set(line.node, [...(unadjudicated.get(line.node) ?? []), line]);
  const advisorLast = new Map<string, AdvisorEvent>();
  for (const ev of readAdvisorEvents(rec.cwd, rec.runId)) advisorLast.set(ev.node, ev);
```

Then inside the pending-node loop, when composing `nodes[name]`:

```ts
    const carry: string[] = [];
    for (const c of unadjudicated.get(name) ?? [])
      carry.push(`- unadjudicated CHALLENGE from prior run: ${c.notes ?? "(see trace)"}`);
    const adv = advisorLast.get(name);
    if (adv) carry.push(`- advisor fired at round ${adv.round} (tier ${adv.tier}${adv.streak ? `, streak ${adv.streak}` : ""})`);
    const objective = carry.length
      ? `${node.objective}\n\n## Resume context\n${carry.join("\n")}`
      : node.objective;
    nodes[name] = { ...nodeRest, objective, depend_on: carriedDeps, ...(fanOut ...), refs: [...] };
```

(Import `readAdvisorEvents`, `readDispatches`, type `AdvisorEvent` from `./ledger.js`.)

- [ ] **Step 4:** `bun test tests/unit/run-resume.test.ts` → PASS.
- [ ] **Step 5:** Commit: `feat(resume): unresolved-dispatch reconciliation + judgment carryover`

---

### Task 3: CLI verbs — `run dispatch`, `run land`, `run take`, `node --attempt`

**Files:**
- Modify: `src/cli/commands/run.ts` (subcommand dispatch ~line 46-215; add `.option("--attempt <n>")`, `.option("--commit <sha>")` to the run command options ~line 31-45)
- Modify: `src/cli/command-registry.ts` (`run:` array, line 48)
- Test: `tests/unit/run-cli.test.ts`

**Interfaces:**
- Consumes `appendDispatch`, `landNode`, `readDispatches`, `reconcileRun` (Tasks 1-2).
- Produces CLI surface: `gk run dispatch <node> [--attempt N] [--via task|extension] [--pid N]`; `gk run land <node> --commit <sha>`; `gk run take --from <run-id>`; `gk run node <id> --attempt N`.

- [ ] **Step 1: Failing tests** — `run-cli.test.ts` style is spawn-CLI-or-call-handler; add:

```ts
test("run dispatch records intent and appears in take/status", async () => { /* spawn gk run dispatch build --via task; assert dispatch.jsonl row */ });
test("run land requires --commit and an ok line", async () => { /* expect fail code LAND_NOT_OK */ });
test("run take clears stale .active and stamps takes_over", async () => {
  // startRun; delete process liveness check target; gk run take --from <id>
  // → .active cleared, meta.json has takes_over, run can start again
});
test("run take refuses when dispatch pids are alive", async () => { /* seeded pid = process.pid → TAKEOVER_BLOCKED */ });
test("node --attempt writes attempt field", async () => { /* trace line has attempt: 2 */ });
```

- [ ] **Step 2:** run → FAIL (`UNKNOWN_RUN_SUBCOMMAND`).

- [ ] **Step 3: Implement.** Add to `GROUP_SUBCOMMANDS.run`: `"dispatch", "land", "take"` (alphabetical order the array already follows loosely — insert after `"analyze"`-appropriate spots; keep `"start","node","end","status","resume","round","analyze"` plus new: `["start","node","dispatch","land","end","status","resume","take","round","analyze"]`).

Add CLI options on the `run` command builder: `.option("--attempt <n>", "node/dispatch: attempt number")`, `.option("--commit <sha>", "land: integration commit")`, `.option("--via <via>", "dispatch: task|extension")`, `.option("--pid <pid>", "dispatch: child pid")`, `.option("--from <run>", "take: run id to take over")`.

In the action body:

```ts
        if (subcommand === "dispatch") {
          const node = Array.isArray(args) ? args[0] : args;
          if (!node) { emit(fail("MISSING_ARG", "dispatch requires a node id")); return; }
          try {
            emit(ok(appendDispatch(cwd, {
              node: String(node),
              attempt: opts.attempt == null ? null : Number(opts.attempt),
              via: opts.via ?? "task",
              pid: opts.pid == null ? null : Number(opts.pid),
            })));
          } catch (e) { const { code, message } = errCode(e); emit(fail(code, message)); }
          return;
        }
        if (subcommand === "land") {
          const node = Array.isArray(args) ? args[0] : args;
          if (!node || !opts.commit) { emit(fail("MISSING_ARG", "land requires a node id and --commit <sha>")); return; }
          try { emit(ok(landNode(cwd, String(node), String(opts.commit)))); }
          catch (e) { const { code, message } = errCode(e); emit(fail(code, message)); }
          return;
        }
        if (subcommand === "take") {
          const target = opts.from ?? (Array.isArray(args) ? args[0] : args);
          if (!target) { emit(fail("MISSING_ARG", "take requires --from <run-id>")); return; }
          try {
            // Refuse takeover while the old run's recorded pids are alive.
            const live = readDispatches(cwd, String(target))
              .filter((d) => d.pid != null && d.pid !== process.pid)
              .filter((d) => { try { process.kill(d.pid!, 0); return true; } catch { return false; } });
            if (live.length > 0)
              { emit(fail("TAKEOVER_BLOCKED", `run ${target} has live dispatch pids: ${live.map((d) => d.pid).join(", ")}`)); return; }
            // Reconcile first so the takeover payload carries truth, then clear.
            const rec = reconcileRun(cwd, String(target), { force: opts.force });
            rmSync(activeFilePath, { force: true }); // helper: expose activeFile path or add clearActiveRun(cwd) in ledger.ts
            emit(ok({ taken_from: target, unresolved: rec.unresolved, pending: rec.pending }));
          } catch (e) { const { code, message } = errCode(e); emit(fail(code, message)); }
          return;
        }
```

Add `clearActiveRun(cwd)` export in `ledger.ts` (one line: `rmSync(activeFile(cwd), { force: true })`) rather than exporting the path. In `node` subcommand, add `attempt: opts.attempt == null ? null : Number(opts.attempt)` to the `appendNode` arg (field is optional on TraceLine — pass through).

In `status` subcommand payload, add `.active` age:

```ts
          const meta = dir ? readRunMeta(cwd, basename(dir)) : null;
          emit(ok({ active: dir, active_age_ms: meta ? Date.now() - Date.parse(meta.started_at) : null, advisor_events, resumes_chain: chain }));
```

- [ ] **Step 4:** `bun test tests/unit/run-cli.test.ts` → PASS; `bun run parity` (or `bun scripts/check-cli-parity.ts`) green after `bun run build`.
- [ ] **Step 5:** Commit: `feat(cli): run dispatch/land/take, --attempt, stale-run status age`

---

### Task 4: `gk evidence invalidate` + marker `superseded`

**Files:**
- Modify: `src/evidence/marker.ts` (KEYS list ~line 20, MarkerMeta ~line 6)
- Modify: `src/cli/commands/evidence.ts` (subcommand dispatch ~line 25-70)
- Modify: `src/cli/command-registry.ts` (`evidence:` array)
- Test: `tests/unit/marker.test.ts`, `tests/unit/evidence-cli.test.ts`

**Interfaces:**
- Produces: `MarkerMeta.superseded: string | null` (reason/ts string); `parseMarker`/`renderMarker` handle it; freshness unchanged (`superseded` evidence still parses `fresh`/`stale` by fingerprint — the gate consumes supersession via scorecard, see Task 5). `gk evidence invalidate --key <k> [--note <r>]`.

- [ ] **Step 1: Failing tests:**

```ts
// marker.test.ts
test("renderMarker/parseMarker round-trips superseded", () => {
  const m = renderMarker({ ...base, superseded: "premise disproved 2026-09-28" }, "body");
  expect(parseMarker(m)?.superseded).toBe("premise disproved 2026-09-28");
});
// evidence-cli.test.ts
test("evidence invalidate writes superseded marker", () => { /* gk evidence add → gk evidence invalidate --key k → parseMarker shows superseded */ });
test("evidence invalidate on missing key fails", () => { /* EVIDENCE_KEY_MISSING */ });
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** `marker.ts`: add `"superseded"` to `KEYS` and `superseded: string | null` to `MarkerMeta`; in `parseMarker` add `superseded: s(raw.superseded)`. In `store.ts` `addEvidence`'s `meta` object add `superseded: null`.

New `evidence.ts` subcommand:

```ts
      if (subcommand === "invalidate") {
        if (!opts.key) { emit(fail("MISSING_ARG", "evidence invalidate requires --key <k>")); return; }
        try {
          const graph = loadGraph(join(cwd, "graph.yaml"));
          const p = join(cwd, graph.outputs.evidence_dir, `${opts.key}.md`);
          if (!existsSync(p)) { emit(fail("EVIDENCE_KEY_MISSING", `no evidence file for key "${opts.key}"`)); return; }
          const content = readFileSync(p, "utf-8");
          const meta = parseMarker(content) ?? { /* markerless: build minimal meta */ key: String(opts.key), run_id: null, node: null, fingerprint_head: null, fingerprint_tree: null, artifact: null, artifact_sha256: null, bytes: null, ts: null, note: null };
          const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "");
          writeFileSync(p, renderMarker({ ...meta, superseded: opts.note ?? `invalidated ${new Date().toISOString()}` }, body));
          emit(ok({ key: opts.key, superseded: true }));
        } catch (e) { emit(fail("EVIDENCE_ERROR", e instanceof Error ? e.message : String(e))); }
        return;
      }
```

Add `"invalidate"` to `GROUP_SUBCOMMANDS.evidence`. New imports in evidence.ts: `existsSync`, `readFileSync`, `parseMarker`, `renderMarker`.

- [ ] **Step 4:** `bun test tests/unit/marker.test.ts tests/unit/evidence-cli.test.ts` → PASS.
- [ ] **Step 5:** Commit: `feat(evidence): invalidate verb, superseded marker field`

---

### Task 5: Gate — strict blocks `unknown`, `superseded` blocks, `require_landed`

**Files:**
- Modify: `src/schemas/graph.schema.ts` (EvidenceConfig ~line 127-133 — add `require_landed: z.boolean().default(false)`)
- Modify: `src/cli/commands/gate.ts` (`gateGraph` ~31-60, command ~72-100)
- Test: `tests/unit/gate.test.ts`, `tests/unit/gate-freshness.test.ts`

**Interfaces:**
- Consumes `MarkerMeta.superseded` (Task 4), `landed` trace field (Task 1).
- `GateResult` gains `warnings: string[]` and `unlanded: string[]`.

- [ ] **Step 1: Failing tests:**

```ts
test("strict freshness BLOCKs markerless (unknown) evidence with warning", () => {
  // evidence file exists, no frontmatter, freshness: strict → verdict BLOCK, warnings names key
});
test("superseded evidence BLOCKs regardless of freshness", () => { /* verdict BLOCK, missing includes key */ });
test("require_landed BLOCKs ok-but-unlanded node evidence", () => {
  // graph evidence.require_landed: true; run trace has ok node, no landed → BLOCK, unlanded: ["build"]
});
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** `gate.ts`:

```ts
// in the per-key loop, also parse superseded:
//   const marker = parseMarker(content);
//   if (marker?.superseded) → scorecard "missing" semantics: treat as absent.
// Concretely: superseded keys join `missing` via evidence[key] = undefined before scoreWorkProduct.

// after `stale` computation:
const unknown = requiredKeys.filter((k) => freshness[k] === "unknown" && base.scorecard[k] === "ok");
const warnings = opts?.strict && unknown.length > 0
  ? [`unstamped evidence (no fingerprint marker) treated as failing under strict freshness: ${unknown.join(", ")} — write evidence via \`gk evidence add\``]
  : [];
const unlanded: string[] = [];
if (opts?.requireLanded && opts.cwd) {
  const id = activeRun(opts.cwd) ? basename(activeRun(opts.cwd)!) : readRunIndex(opts.cwd).at(-1)?.id;
  if (id) for (const t of readTrace(opts.cwd, id))
    if (t.status === "ok" && !t.landed && t.evidence.some((e) => requiredKeys.includes(e)) && !unlanded.includes(t.node))
      unlanded.push(t.node);
}
const verdict =
  (opts?.strict && (stale.length > 0 || unknown.length > 0)) || unlanded.length > 0 ? "BLOCK" : base.verdict;
```

Wait — simpler and more honest: `scoreWorkProduct` decides presence; gate layers freshness + landed. Keep `verdict` composition as above; add `warnings` and `unlanded` to the returned result and the emit payloads.

`gateGraph` signature: `opts?: { cwd?: string; strict?: boolean; requireLanded?: boolean }`. Command reads `graph.evidence.require_landed`. Schema: add `require_landed: z.boolean().default(false)` to the evidence config object (find `freshness` field, add beside it).

Imports needed in gate.ts: `activeRun`, `readRunIndex`, `readTrace` from `../../memory/ledger.js`; `basename` from `node:path` (already imported `join` — check).

- [ ] **Step 4:** `bun test tests/unit/gate.test.ts tests/unit/gate-freshness.test.ts` → PASS.
- [ ] **Step 5:** Commit: `feat(gate): strict blocks unknown, superseded, unlanded`

---

### Task 6: Constraint provenance (`source: human|author`)

**Files:**
- Modify: `src/schemas/graph.schema.ts` (comment at ConstraintValue ~line 13; no type change — `source` is already a legal record value)
- Modify: `src/compiler/validate.ts` (add advisory check near constraints usage ~line 208)
- Test: `tests/unit/validate.test.ts`

**Interfaces:**
- `constraints` entries may carry `source: "human" | "author"`; any other `source` value → advisory finding; `source: human` documented as agent-immutable.

- [ ] **Step 1: Failing test:**

```ts
test("constraints source other than human|author emits advisory", () => {
  const findings = validateGraph(graphWithConstraint({ no_write: true, source: "agent" }), cwd);
  expect(findings.some((f) => f.code === "constraint_source" && !isBlocking(f))).toBe(true);
});
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** In `validateGraph`, after the existing constraint scan:

```ts
  for (const [id, node] of Object.entries(graph.nodes))
    for (const c of node.constraints)
      if ("source" in c && c.source !== "human" && c.source !== "author")
        findings.push({ severity: "advisory", code: "constraint_source", node: id,
          message: `constraint source "${String(c.source)}" must be "human" or "author"` });
```

Match the exact `findings.push`/`Finding` shape used by existing advisories in that file (`owns_overlap`, `unknown_role`) — read `validate.ts:160-230` before writing. Update the schema comment at line ~10-13 to document `source: human` = human-declared, never modifiable by agents; `source: author` (default) = graph-author declared.

- [ ] **Step 4:** `bun test tests/unit/validate.test.ts` → PASS.
- [ ] **Step 5:** Commit: `feat(validate): constraint provenance advisory`

---

### Task 7: `gk-subagent` extension — auto dispatch-intent

**Files:**
- Modify: `kits/_core/extensions/gk-subagent.ts` (`dispatch()` ~line 54-157)
- Test: `tests/unit/pi-extension.test.ts` (or the existing extension test file — check which covers dispatch)

**Interfaces:**
- Consumes `appendDispatch` semantics — but the extension is a standalone artifact (kit-shipped, no import of `src/`). It writes `dispatch.jsonl` directly with the same line shape.

- [ ] **Step 1: Failing test** — stub `omp` binary test (pattern from existing kill-path tests): dispatch with a `cwd` arg; assert `<cwd>/.graphkit/runs/<active>/dispatch.jsonl` gains a `via:"extension"` line with `pid` before spawn returns.

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** — in `dispatch()`, immediately before `spawn(...)`:

```ts
  // Dispatch-intent record: written before spawn so a crashed coordinator
  // distinguishes "dispatched but quiet" from "never dispatched" on resume.
  try {
    const runsDir = join(args.cwd ?? process.cwd(), ".graphkit", "runs");
    const active = join(runsDir, ".active");
    if (existsSync(active)) {
      const dir = readFileSync(active, "utf-8").trim();
      appendFileSync(join(dir, "dispatch.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), node: args.node ?? null, attempt: args.attempt ?? null, via: "extension", pid: child.pid ?? null })}\n`);
    }
  } catch { /* intent write is best-effort; never fail a dispatch over bookkeeping */ }
```

Write AFTER spawn returns (need `child.pid`) but BEFORE awaiting — intent still precedes any result. Pass `node`/`attempt`/`cwd` through `DispatchArgs` if absent (check current args shape; add optional fields).

- [ ] **Step 4:** extension test → PASS.
- [ ] **Step 5:** Commit: `feat(extension): dispatch-intent write before extension dispatch`

---

### Task 8: `gk-execute` SKILL.md contract

**Files:**
- Modify: `kits/_core/skills/gk-execute/SKILL.md`
- Test: `tests/unit/pi-kit.test.ts` — add assertions mirroring existing golden checks.

**Interfaces:** Text contract only; consumes all verbs from Tasks 1-7.

- [ ] **Step 1:** Update dispatch section — before each `task()` batch AND each `gk_dispatch_agent` call: `gk run dispatch <node> --attempt N --via task`. After batch: `hub jobs` snapshot must show one running row per spawned node before wave wait; missing row → `gk run node <id> --status fail --notes launch-lost` + stop wave.
- [ ] **Step 2:** Evidence step → nodes write evidence files then stamp via `gk evidence add <file> --key <k> --node <id>`; markerless evidence fails `strict` freshness.
- [ ] **Step 3:** Challenge adjudication: record `gk run node <id> --status challenge --notes "disposition=accept|modify|reject|defer reason=…"`; `CHALLENGE: plan` → suspend via node `gate` human-approval (never auto-adjudicate plan challenges).
- [ ] **Step 4:** Worktree merge protocol additions: (a) wave N+1 worktrees branch after wave N merges; (b) post-merge owns check `git diff --name-only` ⊆ node `owns` globs else abort+fail note `owns-violation`; (c) re-stamp evidence post-merge commit (`gk evidence add` again); (d) after last merge, rerun repo suite + `gk gate` on main tree; (e) merge abort → `gk run node <id> --status fail --notes merge-conflict:<branch>`; (f) after each merge `gk run land <node> --commit <sha>`; (g) `gk run end` reports orphaned `.graphkit/worktrees/*` + `gk/*` branches.
- [ ] **Step 5:** Resume: surface `unresolved` list to user before re-dispatch; `gk run take --from <id>` documented for stale `.active`.
- [ ] **Step 6:** Message stamping: every `hub send`/task brief opens with `run: <id> node: <id> rev: <graph_sha256[:12]>`.
- [ ] **Step 7:** Regen: `bun run gen:kits` && `bun run scripts/sync-omp.ts`; `bun test tests/unit/pi-kit.test.ts` → PASS.
- [ ] **Step 8:** Commit: `feat(skill): dispatch-intent, land/take, challenge dispositions, merge hardening`

---

### Task 9: `analyze` — dispositions + integration failures

**Files:**
- Modify: `src/memory/analyze.ts` (suggestions builder ~line 122-152)
- Test: `tests/unit/run-analyze.test.ts`

**Interfaces:** Consumes `notes` conventions `disposition=*` and `merge-conflict:*`.

- [ ] **Step 1: Failing test:**

```ts
test("analyze counts challenge dispositions and merge conflicts", () => {
  // trace: challenge --notes disposition=accept; fail --notes merge-conflict:gk/x
  // → result.challenges.dispositions.accept === 1; result.nodes.integration_failures === 1
});
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** — in `analyzeRun`, over trace lines: parse `disposition=(accept|modify|reject|defer)` from challenge notes into a counts object; parse `merge-conflict:` prefix in fail notes into `integration_failures`. Add to `AnalyzeResult` — `challenges: { total, adjudicated, dispositions: Record<string, number> }` and `nodes.integration_failures`. Update the zero-dissent/unadjudicated suggestions to use the counts instead of raw scans where cleaner.

- [ ] **Step 4:** `bun test tests/unit/run-analyze.test.ts` → PASS.
- [ ] **Step 5:** Commit: `feat(analyze): disposition + integration-failure metrics`

---

### Task 10: `cook-plan` template + `eval-gate` role

**Files:**
- Create: `templates/gallery/cook-plan.gk.yaml`
- Modify: `src/schemas/graph.schema.ts` (role field comment ~line 97), `src/compiler/validate.ts` (`unknown_role` advisory list — add `eval-gate` to known roles)
- Test: `tests/unit/template-schema.test.ts` (or a gallery-validation test — check how existing gallery files are covered)

**Interfaces:** `role: eval-gate` becomes a known role; `analyze.ts` already consumes it (~line 99-104).

- [ ] **Step 1: Failing test:**

```ts
test("gallery cook-plan.yaml validates clean", () => {
  const g = parseGraph("templates/gallery/cook-plan.gk.yaml"); // existing loader
  expect(validateGraph(g, cwd).filter(isBlocking)).toEqual([]);
});
test("role eval-gate is not an unknown_role advisory", () => { /* … */ });
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** — `templates/gallery/cook-plan.gk.yaml` (doc §5 mapping):

```yaml
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: cook-plan
  description: Cook Plan execution loop — plan → bounded implement/test repair → eval gate → integrate
topology: custom
outputs:
  evidence_dir: .graphkit/evidence
evidence:
  required_keys: [plan-doc, impl-report, test-report, eval-verdict]
  freshness: strict
nodes:
  plan:
    agent: research-planner
    model: sonnet
    objective: >-
      Convert the goal into a phase contract: outcome, acceptance criteria,
      owned files, predecessor phases, interface contracts, and assumptions
      open to revision. Separate constraints-with-sources (immutable, source:
      human) from provisional choices.
    evidence: [plan-doc]
  implement:
    agent: implementer
    model: sonnet
    objective: Implement per plan-doc; respect owns and constraints.
    owns: []
    assumptions: []
    depend_on: [plan]
    evidence: [impl-report]
  test:
    agent: test-author
    model: sonnet
    objective: Verify implementation against acceptance criteria; write test-report.
    depend_on: [implement]
    evidence: [test-report]
  evaluate:
    agent: qa-engineer
    role: eval-gate
    model: sonnet
    objective: >-
      Evaluate evidence against acceptance criteria. Evidence must match the
      code being reviewed — stale or unstamped evidence is a BLOCK, not a
      retry. Emit MERGE or BLOCK verdict.
    constraints: [{ no_write: true, source: author }]
    depend_on: [test]
    evidence: [eval-verdict]
  integrate:
    agent: release-manager
    model: sonnet
    objective: >-
      On MERGE: integrate sequentially, run the full repo suite on the
      integrated tree, stamp evidence post-merge, land nodes.
    depend_on: [evaluate]
    evidence: [integration-report]
loops:
  - nodes: [implement, test]
    max_rounds: 3
    gate_evidence: [test-report]
    no_progress_limit: 2
```

(`owns`/`assumptions` left as fill-ins for the user — gallery templates ship skeletons; verify a fully-empty `owns` passes schema, else drop the field.) Add `eval-gate` to the known-roles list wherever `unknown_role` advisory is emitted in `validate.ts`; update schema comment for `role` to list `supervisor` and `eval-gate`.

- [ ] **Step 4:** tests → PASS; `bun src/index.ts validate templates/gallery/cook-plan.gk.yaml` clean.
- [ ] **Step 5:** Commit: `feat(templates): cook-plan gallery template, eval-gate role`

---

### Task 11: Changelog + full verification

**Files:** `CHANGELOG.md`

- [ ] **Step 1:** Add entries under Unreleased: ledger dispatch-intent/`landed`/`attempt`, `run dispatch|land|take`, `evidence invalidate`, gate strict-unknown/`require_landed`/superseded, constraint provenance, resume carryover + unresolved, analyze disposition/integration metrics, cook-plan template, eval-gate role, gk-execute contract updates.
- [ ] **Step 2:** `bun run typecheck && bun run lint && bun test && bun run parity` — all green.
- [ ] **Step 3:** Commit: `docs: changelog for orchestration adoption`

---

## Self-review notes

- Spec §1→Task 1; §2→Tasks 1,3; §3→Tasks 2,3,8,9 (disposition note convention, plan gate, carryover, metric); §4→Tasks 4,5,8 (+owns check, merge timing, launch receipt, message stamping); §5→Task 10; provenance→Task 6.
- `constraints` provenance adds zero schema fields — `source` is a legal record value already.
- Ordering constraint: Tasks 1-2 (ledger) precede 3 (CLI); 4 precedes 5 (gate consumes `superseded`); 7,8 independent but 8 documents verbs from 3. Tasks 6,9,10 independent.
