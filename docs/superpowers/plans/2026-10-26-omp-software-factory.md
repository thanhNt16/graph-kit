# OMP Software Factory (`gk factory`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A board-driven software factory on omp: `gk factory tick` polls an issue board (local / GitHub / GitLab / Jira+Bitbucket), claims Ready cards, runs one lane graph per lane (intake → build → QA → review) through `gk exec --worktree` with a role-scoped omp `AgentProfile` (`--model/--thinking/--skills/--tools/--max-time`), gates every lane on evidence, and performs all VCS/board side effects itself (push, PR, proof comment, move, merge) — workers never hold a token.

**Architecture:** `src/factory/` = `config.ts` (zod `FactoryConfigSchema` + `AgentProfileSchema`), `providers/{types,local,github,gitlab,jira,bitbucket}.ts`, `workspace.ts`, `journal.ts` (per-card state under `.graphkit/factory/cards/`), `planner.ts` (pure: snapshot → actions), `executor.ts` (applies actions), `lane.ts` (one lane run for one card), `policy.ts` (guard policy + env scrub). Engine change: `src/exec/spawn.ts` learns `--skills/--thinking/--max-time/-e/--mode json` + caller env. New kit extension `gk-factory-guard.ts`, 11 `factory-*` skills, 4 gallery lane templates.

**Tech Stack:** TS + bun, zod 4, `yaml`, `gh` CLI (GitHub), `fetch` (GitLab/Jira/Bitbucket). No new runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-10-26-omp-software-factory-design.md`](../specs/2026-10-26-omp-software-factory-design.md). **omp version pinned:** `@oh-my-pi/pi-coding-agent@18.12.6`.

## Global Constraints

- Repo: graph-kit, TS + bun. Per task: `bun test tests/unit/<file>` + `bun run typecheck`. Full `bun run ci:local` only at phase gates (needs `~/.bun/bin` **and** a node dir on PATH — npm pack tests fail without node).
- Reuse, don't re-implement: `planGraph`, `runGraph`, `SpawnRunner`/`WorktreeRunner` (`src/cli/commands/exec.ts`), `spawnDispatch` (`src/exec/spawn.ts`), `startRun/appendDispatch/endRun` (`src/runs/ledger.ts`), `withFeatureLock` (`src/features/store.ts`), `addTask/claimTask` (`src/queue/store.ts`), `gk schedule emit` formats, `GraphKitError` + `emit/ok/fail` envelopes, `formatZodIssues`.
- `gk` never calls a model; no daemon. Every provider/network call goes through an injectable seam (`Exec` for `gh`, `FetchLike` for REST) — unit tests use recorded fixtures under `tests/fixtures/factory/`, never the network.
- Kit files are verbatim (no imports from `src/`): any change under `kits/_core/` is followed by `bun run gen:kits && bun run sync:omp`. Any CLI surface change is followed by `bun run gen:manifest`.
- Behavioral fixes to the spawn contract land in **both** `src/exec/spawn.ts` and `kits/_core/extensions/gk-subagent.ts` (documented duplication).
- New skills must pass the learn admission lint (trigger-cued description ≤60 chars, body ≤200 lines, no lint-family hits).
- Commit per task, conventional messages (`feat(factory): …`, `feat(exec): …`, `test(factory): …`). CHANGELOG `## [Unreleased]` entry per phase.
- Branch: integration branch `devin/omp-software-factory`; one PR per phase into it, final PR into `main`.

## File map

- **Create**
  - `src/factory/{config,journal,planner,executor,lane,policy,workspace,omp-events}.ts`
  - `src/factory/providers/{types,index,local,github,gitlab,jira,bitbucket}.ts`
  - `src/cli/commands/factory.ts`
  - `kits/_core/extensions/gk-factory-guard.ts`
  - `kits/_core/skills/factory-{intake,repro-check,dedup-ladder,build,git-sync,scrutiny,ui-journey,proof,adversarial-review,heresy-lint}/SKILL.md`, `kits/_core/skills/context-docs/SKILL.md`
  - `kits/_core/agents/factory-{intake,worker,qa,reviewer}.md`
  - `templates/gallery/factory-{intake,build,qa,review}.gk.yaml`
  - `templates/factory/factory.yaml` (starter config used by `gk factory init`)
  - `tests/unit/factory-{config,journal,planner,executor,lane,policy,guard,workspace,omp-events,cli}.test.ts`
  - `tests/unit/factory-provider-{local,github,gitlab,jira,bitbucket}.test.ts`
  - `tests/integration/factory-local-e2e.test.ts`, `tests/fixtures/factory/{gh,gitlab,jira,bitbucket,omp}/…`
  - `scripts/omp-contract-probe.ts`
  - `docs/factory.md`
- **Modify**
  - `src/exec/spawn.ts`, `kits/_core/extensions/gk-subagent.ts` (args + env + json mode)
  - `src/cli/commands/exec.ts` (`dispatchConstraints` → lowercase omp tool names; profile plumbing)
  - `src/cli/app.ts`, `src/cli/command-registry.ts`, `scripts/check-cli-parity.ts`, `cli-manifest.json`, `tests/unit/cli-trust.test.ts`
  - `src/errors.ts` (factory codes if codes are enumerated there)
  - `docs/software-factory.md`, `docs/honest-gaps.md` (tick ≠ daemon note), `README.md`, `docs/graphkit.html`, `CHANGELOG.md`

---

## Phase P0 — omp contract + engine flags

### Task 0: omp 18.12.6 contract probe (spike, recorded fixtures)

**Files:** Create `scripts/omp-contract-probe.ts`, `tests/fixtures/factory/omp/*.jsonl`, `tests/fixtures/factory/omp/CONTRACT.md`.

The spec marks four omp behaviors as unverified. Pin each before anything depends on it.

- [ ] **Step 1:** Install `@oh-my-pi/pi-coding-agent@18.12.6` (already on the VM as `omp`); configure one cheap model (`omp models`, `@smol`).
- [ ] **Step 2:** Probe script runs, captures stdout/stderr/exit code to fixtures:
  1. `printf %s "say OK" | omp -p --mode json --no-session --approval-mode yolo` → event stream shape (record which event carries final assistant text).
  2. same + `--append-system-prompt "$(head -c 8000 kits/pi/agents/implementer.md)"` → accepted via argv, no E2BIG.
  3. `--skills factory-build,does-not-exist` → warning vs hard error.
  4. `--tools read,grep` then ask it to write a file → tool absent (no write attempted).
  5. `-e kits/_core/extensions/gk-factory-guard.ts` (stub that blocks all `bash`) → blocked reason surfaces in events, exit code.
  6. `--max-time 5s` on a long task → exit code / event on timeout.
  7. `--model @smol` / `@default` / `@slow` resolution with a models config having only `default`.
- [ ] **Step 3:** Write `CONTRACT.md`: one line per probe — flag, observed behavior, fixture path. Any probe that contradicts the spec → stop and update spec §3.3 before Task 1.
- [ ] **Step 4:** Commit — `chore(factory): omp 18.12.6 contract probe + recorded fixtures`

### Task 1: `DispatchArgs` gains skills/thinking/max_time/extensions/env/json

**Files:** Modify `src/exec/spawn.ts`, `kits/_core/extensions/gk-subagent.ts`, `src/cli/commands/exec.ts`. Test: `tests/unit/exec-spawn.test.ts`, `tests/unit/exec-cli.test.ts`.

**Interface:**
```ts
export interface DispatchArgs {
  // existing fields …
  skills?: string[];          // → --skills a,b   ([] → --no-skills)
  thinking?: string;          // → --thinking <v>
  max_time?: string;          // → --max-time <v>
  extensions?: string[];      // → -e <path> (each)
  role_prompt?: "append" | "inline";  // "append" → --append-system-prompt; default "inline" (today's behavior)
  mode_json?: boolean;        // → --mode json; output parsed via omp-events.ts
  env?: Record<string, string>;       // replaces {...process.env} when set (GK_PROMPT still injected)
  approval_mode?: "yolo" | "write";   // → --approval-mode
  no_session?: boolean;       // → --no-session
}
export interface DispatchResult { ok: boolean; output: string; exit_code: number; timed_out?: boolean; events_path?: string }
```
- [ ] **Step 1: failing tests** — `buildPiArgs({skills:["a","b"]})` contains `--skills a,b`; `skills: []` → `--no-skills`; unset → neither (back-compat); `thinking`, `max_time`, `extensions` (order preserved), `approval_mode`, `no_session`, `mode_json` each emit exactly their flag; constraint toolsets now lowercase (`--tools read,glob,grep`).
- [ ] **Step 2:** `SpawnRunner.dispatch` forwards `node.skills` (fixes the silent drop) — test with a planned node carrying `skills: [gk-recall]` asserting the argv.
- [ ] **Step 3:** env replacement test: `env: {PATH, HOME}` → child sees no `GH_TOKEN` (spawn `sh -c 'env'` via an injectable binary path `GK_OMP_BIN` used only in tests; default `omp`).
- [ ] **Step 4:** Implement in `spawn.ts`; mirror into `gk-subagent.ts`; `bun run gen:kits && bun run sync:omp`.
- [ ] **Step 5:** Verify — `bun test tests/unit/exec-spawn.test.ts tests/unit/exec-cli.test.ts tests/unit/pi-kit.test.ts && bun run typecheck`.
- [ ] **Step 6:** Commit — `feat(exec): forward node skills + thinking/max-time/extensions/env to omp children`

### Task 2: `--mode json` event parsing

**Files:** Create `src/factory/omp-events.ts` (used by spawn when `mode_json`). Test: `tests/unit/factory-omp-events.test.ts` over Task 0 fixtures.

- [ ] Parse the JSONL stream line-by-line (tolerate non-JSON lines → keep as `stderr_like`); `output` = final assistant text per CONTRACT.md; collect `tool_blocked` reasons; write raw stream to `<run>/evidence/omp_events.jsonl` and return `events_path`.
- [ ] Tests: happy stream, truncated stream (process killed) → `ok:false` with partial output, blocked-tool stream → `blocked: [{tool, reason}]`.
- [ ] Commit — `feat(exec): parse omp --mode json event streams into dispatch results`

**P0 gate:** `bun run ci:local` green; CHANGELOG Unreleased: "gk exec forwards node `skills` to omp (`--skills`)".

---

## Phase P1 — config, policy, guard, skills

### Task 3: `FactoryConfigSchema` + `AgentProfileSchema`

**Files:** Create `src/factory/config.ts`, `templates/factory/factory.yaml`. Test: `tests/unit/factory-config.test.ts`.

**Interface:**
```ts
export const LaneKeySchema = z.enum(["ready","building","qa","review","blocked","done"]);
export const AgentProfileSchema = z.object({
  model: z.string().min(1), thinking: z.string().optional(),
  tools: z.array(z.string()).min(1), skills: z.array(z.string()).default([]),
  max_time: z.string().optional(), budget_tokens: z.number().int().positive().optional(),
  approval_mode: z.enum(["yolo","write"]).default("yolo"),
}).strict();
export const FactoryConfigSchema = z.object({ version: z.literal(1), board, vcs, dispatch, agents: z.record(z.string(), AgentProfileSchema), qa, lanes }).strict();
export function loadFactoryConfig(cwd: string, path = ".omp/factory.yaml"): FactoryConfig;  // throws GraphKitError("FACTORY_CONFIG")
export function parseDuration(s: string): number;  // "60s" | "10m" | "1h" → ms
```
- [ ] Tests: starter template parses; `temperature:` → `FACTORY_CONFIG` with hint "omp has no temperature flag"; `max_tokens_budget` → hint "use budget_tokens"; unknown provider; lane → unknown agent; `max_parallel` non-positive; per-provider block required (`board.provider: github` without `board.github`).
- [ ] Commit — `feat(factory): factory.yaml schema with role-scoped agent profiles`

### Task 4: `validateFactory` — references, authority lint, env presence

**Files:** `src/factory/config.ts` (+`validateFactory(cwd, cfg): Finding[]`). Test: same file.

- [ ] Skill resolution over omp discovery roots: `<cwd>/.omp/skills/<n>/SKILL.md`, each ancestor `.omp/skills`, `~/.omp/agent/skills` (inject `home` for tests) → `FACTORY_UNKNOWN_SKILL`.
- [ ] Tool names vs a vendored copy of omp 18.12.6 `BUILTIN_TOOL_NAMES` (`src/factory/omp-tools.ts`, comment with version) → `FACTORY_UNKNOWN_TOOL`.
- [ ] Authority lint `FACTORY_AUTHORITY`: any profile with `github`, `task`, `manage_skill`, `learn`; any profile bound to `qa`/`review` lanes with `edit`/`write`/`ast_edit`.
- [ ] Lane graphs resolve + `validateGraph` has no blocking findings.
- [ ] Env presence by provider: github → `GH_TOKEN|GITHUB_TOKEN` (or `gh auth status` ok via injected exec); gitlab → `GITLAB_TOKEN`; jira → `JIRA_EMAIL`+`JIRA_TOKEN`; bitbucket → `BITBUCKET_USER`+`BITBUCKET_APP_PASSWORD` → `FACTORY_MISSING_ENV` (names only).
- [ ] Commit — `feat(factory): validate skills, tools, authority boundaries and provider env`

### Task 5: lane policy + env scrub (`src/factory/policy.ts`)

**Interface:**
```ts
export interface LanePolicy { card: string; lane: LaneKey; worktree: string; branch: string; owns: string[]; deny_bash: string[]; log_path: string }
export function policyFor(cfg: FactoryConfig, card: CardJournal, lane: LaneKey): LanePolicy;
export function laneEnv(parent: NodeJS.ProcessEnv, cfg: FactoryConfig, policy: LanePolicy): Record<string,string>;
```
- [ ] `deny_bash` = spec §3.4 list as regex sources, plus `git push` allowed only as `git push origin <branch>` (but dispatcher pushes, so default deny all push).
- [ ] `laneEnv`: keep `PATH, HOME, USER, LANG, TERM, TMPDIR, SHELL` + `dispatch.env_passthrough`; drop everything matching `/TOKEN|SECRET|PASSWORD|_KEY$|^SSH_AUTH_SOCK$/` unless passthrough; set `GIT_TERMINAL_PROMPT=0`, `GK_FACTORY_POLICY=<json>`.
- [ ] Tests: GH_TOKEN dropped, ANTHROPIC_API_KEY kept when passthrough, policy JSON round-trips.
- [ ] Commit — `feat(factory): per-lane policy and credential-scrubbed child env`

### Task 6: `gk-factory-guard.ts` omp extension

**Files:** Create `kits/_core/extensions/gk-factory-guard.ts` (verbatim, no `src/` imports). Test: `tests/unit/factory-guard.test.ts` (import the kit file directly, drive a fake `pi.on("tool_call")`).

- [ ] Reads `GK_FACTORY_POLICY`; absent → no-op (extension is safe to load in non-factory sessions).
- [ ] `tool_call` → `{block:true, reason}` for: bash matching `deny_bash`; `edit|write|ast_edit` with resolved path outside `worktree` or outside `owns` (when non-empty); appends JSONL to `log_path`. Uses the `ToolCallEventResult` shape from omp `shared-events.ts`.
- [ ] Tests: `gh pr merge 3` blocked; `git push --force` blocked; `bun test` allowed; write to `../other` blocked; write inside worktree allowed; symlink escape blocked (realpath).
- [ ] `bun run gen:kits && bun run sync:omp`; verify with Task 0 probe 5 using the real file.
- [ ] Commit — `feat(factory): gk-factory-guard omp extension enforcing lane authority`

### Task 7: skills pack + lane agents

**Files:** 11 `kits/_core/skills/*/SKILL.md` + 4 `kits/_core/agents/factory-*.md` (spec §3.8). Test: `tests/unit/kit-skill-parity.test.ts` (extend), new lint check in `tests/unit/factory-config.test.ts` that runs the learn admission lint over each new SKILL.md.

- [ ] Each skill: frontmatter `name`, `description` with `when:` trigger cue ≤60 chars, contract section (inputs → evidence key it must write via `gk evidence add`), "never" list (never push, never merge, never edit outside worktree).
- [ ] Agents carry role prose only; tools/skills come from the profile (no `tools:` in frontmatter for pi).
- [ ] `gen:kits` + `sync:omp`; `bun test tests/unit/kit-*.test.ts tests/unit/pi-kit.test.ts`.
- [ ] Commit — `feat(factory): role-scoped skill pack and lane agents for omp + claude kits`

**P1 gate:** `ci:local` green; `gk factory validate` (Task 12 stub OK) passes on starter config in a scratch repo after `gk init --target pi`.

---

## Phase P2 — local provider, journal, tick, lanes (full flow offline)

### Task 8: provider types + local provider

**Files:** `src/factory/providers/{types,index,local}.ts`. Test: `tests/unit/factory-provider-local.test.ts`.

- [ ] Types exactly per spec §3.1 (`IssueTask`, `IIssueBoardProvider`, `IVCSProvider`, `CheckState`, marker helpers `marker(o)`, `parseMarker(body)`).
- [ ] Local board: `.graphkit/factory/board/<id>.yaml` (`{key,title,description,labels,lane,updated_at,comments[]}`), writes via tmp+rename under `withFeatureLock`; `upsertComment` edits by marker.
- [ ] Local VCS: `pushBranch` no-op (records), `openPullRequest` idempotent per branch (`.graphkit/factory/prs.json`), `getChecks` runs `qa.commands` in the worktree → success/failure, `mergePR` = `git merge --squash` into `base_branch` in the main checkout + commit.
- [ ] `createProviders(cfg, deps)` factory in `index.ts`.
- [ ] Commit — `feat(factory): provider interfaces and file-backed local board/VCS`

### Task 9: card journal + workspace

**Files:** `src/factory/{journal,workspace}.ts`. Tests: `factory-journal.test.ts`, `factory-workspace.test.ts` (real temp git repo).

- [ ] `readJournal/writeJournal/listJournals` (`CardJournal` per spec §3.5), atomic writes, schema-validated reads (corrupt file → `FACTORY_CONFIG` finding, not a crash).
- [ ] `Workspace.ensure` = `git worktree add .graphkit/factory/wt/<id> -b factory/<id> <base>`; reuse if present; `remove` = `git worktree remove --force` (branch kept). Same error-message style as `WorktreeRunner` (`WORKTREE_CREATE_FAILED` hint).
- [ ] Commit — `feat(factory): per-card journal and worktree workspace`

### Task 10: pure planner (`planTick`)

**Files:** `src/factory/planner.ts`. Test: `factory-planner.test.ts` (table-driven, no I/O).

**Interface:**
```ts
export type Action =
  | { kind: "claim"; card: IssueTask }
  | { kind: "dispatch"; card: string; lane: LaneKey }
  | { kind: "halt"; card: string; pid: number }
  | { kind: "mark_crashed"; card: string; run_id: string }
  | { kind: "advance"; card: string; lane: LaneKey; verdict: "MERGE" | "BLOCK"; findings?: string }
  | { kind: "await_checks"; card: string } | { kind: "merge"; card: string } | { kind: "park"; card: string; reason: string };
export interface TickSnapshot { cfg: FactoryConfig; journals: CardJournal[]; board: Record<LaneKey, IssueTask[]>; halted: Set<string>; alive: Set<number>; verdicts: Map<string, "MERGE"|"BLOCK"|null>; checks: Map<string, CheckState> }
export function planTick(s: TickSnapshot): Action[];
```
- [ ] Cases: claim up to `max_parallel` (oldest first, `intake_label` filter, never cards without marker in non-ready lanes); dead pid → `mark_crashed`; halted running → `halt`; build MERGE → advance to qa; qa BLOCK round<max → building; round==max → blocked; review MERGE + checks pending → await; failure → building with failing names; success + `merge.auto` → merge; success + !auto → park "ready to merge"; deterministic order (sort by card id) so `--dry-run` output is stable.
- [ ] Commit — `feat(factory): deterministic tick planner (snapshot → actions)`

### Task 11: lane runner (`gk factory lane`)

**Files:** `src/factory/lane.ts`. Test: `factory-lane.test.ts` with `GK_OMP_BIN` pointing at a fake omp script (`tests/fixtures/factory/fake-omp.sh`) that writes evidence + emits a fixture JSON stream.

- [ ] Materialize lane template with params `{card_key,title,spec,round,prior_findings}`; apply profile to nodes (node value wins for model/thinking; `tools`/`skills` intersected — spec §3.7); set `budget.max_tokens` from `budget_tokens`.
- [ ] `gk run start` in the main checkout; run `runGraph` with `WorktreeRunner`-equivalent rooted at the card worktree (reuse classes from `exec.ts`; extract to `src/exec/runners.ts` if needed — move, don't copy); `SpawnRunner` gets `env: laneEnv(...)`, `extensions: [guard]`, `mode_json: true`, `role_prompt: "append"`, `no_session` for review lane.
- [ ] Halt timer every `halt_poll`: `isTaskHalted` → kill process group, end run `failed --note halted`.
- [ ] Write `.graphkit/factory/cards/<id>.json` `phase: awaiting_advance` + gate verdict on exit.
- [ ] Tests: profile intersection, env has no GH_TOKEN (fake omp dumps env to evidence), halt mid-run kills fake omp (sleeping) within halt_poll, verdict recorded.
- [ ] Commit — `feat(factory): lane runner applying agent profiles to lane graphs`

### Task 12: executor + `gk factory` CLI

**Files:** `src/factory/executor.ts`, `src/cli/commands/factory.ts`, registry/parity/manifest/cli-trust. Tests: `factory-executor.test.ts`, `factory-cli.test.ts`.

- [ ] Executor applies `Action[]` in order with providers + journal; every board write carries a marker; `dispatch` spawns `gk factory lane --card <id>` detached (`setsid`-style `detached:true`, stdio to `.graphkit/factory/logs/<id>-<run>.log`), records pid; claim also `addTask` into `gk queue` (`card-<id>`).
- [ ] Proof comment / PR body renderer: lane, round, verdict, evidence table (key → sha256 short), guard blocks count, run id, `gk run verify` hint.
- [ ] CLI: `init`, `validate`, `tick [--dry-run]`, `run [--interval]`, `lane --card`, `status`, `halt`, `resume`, `schedule --format`; tick lock `.graphkit/factory/tick.lock` → `FACTORY_LOCKED` (exit 0, `skipped:true`).
- [ ] `bun run gen:manifest`; parity + cli-trust tests.
- [ ] Commit — `feat(factory): gk factory CLI (init/validate/tick/run/lane/status/halt/resume/schedule)`

### Task 13: lane templates

**Files:** `templates/gallery/factory-{intake,build,qa,review}.gk.yaml`. Test: new `tests/unit/factory-templates.test.ts` modelled on `software-factory-template.test.ts` (materialize + validate each with sample params).

- [ ] Per spec §3.6 nodes/evidence; QA/review nodes `role: eval-gate`, `no_write`, `freshness: strict`; build has a bounded local loop `implement ↔ self-check` (`max_rounds: 2`, `no_progress_similarity: 0.9`).
- [ ] Commit — `feat(factory): intake/build/qa/review lane templates`

### Task 14: local end-to-end

**Files:** `tests/integration/factory-local-e2e.test.ts`.

- [ ] Scratch git repo (tiny TS project with a failing test + card "make test pass"), `gk init --target pi`, `gk factory init --provider local`, fake omp that edits the file in build lane and writes evidence; loop `tick` until Done; assert: card lane history Ready→Building→In QA→Under Review→Done, PR record, squash commit on `main`, proof comments with markers (no duplicates after extra ticks), `gk run verify --evidence` ok for every run, queue item `card-<id>` done.
- [ ] Bounce case: reviewer fixture BLOCKs round 1 → back to Building with findings → MERGE round 2.
- [ ] Halt case: add `factory:halt` while build runs → parked, process gone.
- [ ] **Real omp run (manual, recorded):** same scratch repo, real `omp` with a cheap model; save `gk factory status --json`, card YAML, run ledgers as artifacts in the PR.
- [ ] Commit — `test(factory): local provider end-to-end (happy path, bounce, halt)`

**P2 gate:** `ci:local` green; real-omp local run artifacts attached to the phase PR.

---

## Phase P3 — GitHub adapter

### Task 15: GitHub board (Projects v2) + VCS

**Files:** `src/factory/providers/github.ts`. Test: `factory-provider-github.test.ts` with recorded `gh` JSON in `tests/fixtures/factory/gh/`.

- [ ] Board via `gh project item-list <n> --owner <o> --format json` (status field), `gh project field-list` once per tick (cache option ids), `gh project item-edit --id --field-id --single-select-option-id`; comments via `gh api repos/{o}/{r}/issues/{n}/comments` (+ `PATCH .../issues/comments/{id}` for upsert); labels via `gh issue edit --add-label/--remove-label`.
- [ ] VCS via `git push origin factory/<id>` (dispatcher env, with token), `gh pr list --head <branch> --json number,url` (idempotency) → `gh pr create`, `gh pr checks <n> --json name,state,link`, `gh pr merge <n> --squash`.
- [ ] Errors → `FACTORY_PROVIDER` with `gh` stderr; rate limit (`403` + `X-RateLimit-Remaining: 0`) → retryable.
- [ ] Commit — `feat(factory): GitHub Projects v2 board + PR adapter via gh`

### Task 16: GitHub live e2e

- [ ] Sandbox repo + project (user-provided or created under the bot account with permission), one issue "Ready" → merged PR with real omp; record run artifacts + screenshots of the board columns in the PR.
- [ ] `gk factory schedule --format gha` emits a workflow that runs `gk factory tick` every 10 min with `GH_TOKEN` + model key secrets.
- [ ] Commit — `docs(factory): GitHub quickstart + scheduled tick workflow`

---

## Phase P4 — GitLab, Jira + Bitbucket

### Task 17: GitLab adapter (`fetch`, REST v4)

- [ ] Board lanes = scoped labels `factory::<lane>` (`PUT /projects/:id/issues/:iid` `add_labels/remove_labels` atomically), notes for comments, MRs (`GET /merge_requests?source_branch=`, `POST /merge_requests`, `PUT .../merge` with `squash`), pipelines for checks (`GET /merge_requests/:iid/pipelines` → latest status mapping).
- [ ] Self-hosted host + `PRIVATE-TOKEN` header; fixtures for each call.
- [ ] Commit — `feat(factory): GitLab issue-board + MR adapter`

### Task 18: Jira board + Bitbucket VCS

- [ ] Jira Cloud REST v3: JQL search for lane (`status = "<name>" AND project = X`), transitions lookup cache (`GET /issue/{key}/transitions`) → `POST` transition, comments (ADF ← markdown via a minimal converter: paragraphs, code blocks, tables-as-code), labels via `PUT /issue/{key}` `update.labels`.
- [ ] Bitbucket Cloud REST 2.0: `pullrequests` create/list by source branch, `/commit/{sha}/statuses` for checks, `/pullrequests/{id}/merge` (`merge_strategy: squash`).
- [ ] Board and VCS providers chosen independently (`board.provider: jira` + `vcs.provider: github` must also work — test it).
- [ ] Commit — `feat(factory): Jira board + Bitbucket PR adapters`

**P4 gate:** fixtures green; live e2e only when the user supplies sandbox projects + tokens (tracked as an explicit open item, not silently skipped).

---

## Phase P5 — docs + release

### Task 19: docs surfaces

- [ ] `docs/factory.md` (quickstart per provider, config reference generated from the zod schema, enforcement layers, failure-mode table), section in `docs/software-factory.md`, `docs/honest-gaps.md` note ("`gk factory tick` is a reconcile pass, not a broker"), README feature row, `docs/graphkit.html` section + `pages.yml` index link.
- [ ] CHANGELOG: stamp `## [x.y.z] - date` matching the next release tag before the release commit (release.yml extracts notes by heading).
- [ ] Final `bun run ci:local`; grep for `<<<<<<<|>>>>>>>` after integration merges.
- [ ] Commit — `docs(factory): factory guide, README, Pages, changelog`

---

## Open questions (answer before P3)

1. **Merge authority default:** `merge.auto: false` (park "ready to merge" for a human) is the proposed default — confirm, or auto-merge on green + review MERGE?
2. **Sandbox targets:** which GitHub repo/project (and later GitLab/Jira instances) should the live e2e runs use?
3. **Model selectors:** keep omp role aliases (`@smol/@default/@slow`) in the starter config, or pin concrete provider/model ids?
4. **Intake pass:** run the intake lane on every claimed card (extra cost, better specs) or only on cards labelled `factory:triage`?
