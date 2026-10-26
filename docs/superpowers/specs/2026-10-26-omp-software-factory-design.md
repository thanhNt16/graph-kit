# OMP Software Factory (`gk factory`) — Design Spec

**Date:** 2026-10-26 · **Status:** draft for review
**Input:** "Swappable VCS & Issue Tracker Provider + Role-Based Skill Registry" design note (user-supplied).
**Grounded against:** graph-kit `main` @ `ce5068b` (v0.3.43) and `@oh-my-pi/pi-coding-agent` **18.12.6** source (`src/cli/flag-tables.ts`, `src/main.ts`, `src/tools/builtin-names.ts`, `src/discovery/builtin.ts`, `src/extensibility/shared-events.ts`, `src/modes/print-mode.ts`).
**Plan:** [`docs/superpowers/plans/2026-10-26-omp-software-factory.md`](../plans/2026-10-26-omp-software-factory.md)

---

## 0. Problem statement

GraphKit already has every *in-run* factory primitive (compiled DAGs, `gk exec` headless omp dispatch, worktree isolation, evidence gates, holdouts, bounded loops, budgets, hash-chained ledger, `gk queue`, `gk schedule`, `gk learn`/`gk selflearn`). What it does **not** have is the *outer loop* that turns a team's issue board into a production line:

1. **No intake from a real tracker.** Work enters only through `gk queue add <yaml>` or a hand-written graph. Nobody's backlog lives in `.graphkit/queue/`.
2. **No per-lane agent profiles.** A node carries `agent`/`model`/`tools`/`skills`, but there is no reusable "the QA agent is model X with skills Y and tools Z" declaration, and `src/exec/spawn.ts` **drops `node.skills` on the floor** — `buildPiArgs` never emits `--skills`, so every headless omp child loads the full skill catalog.
3. **No VCS write-back.** Nothing opens the PR/MR, posts proof to the card, moves the card, or merges. `gk exec --worktree` merges branches *locally*.
4. **No human control surface.** A human can't pause or redirect a running card from the board.

The user-supplied note proposes the right shape — an abstract provider layer plus role-scoped skills, enforced at omp spawn time. This spec makes it concrete for graph-kit + omp, and corrects the parts of the note that don't match omp 18.12.6 (§3.3).

## 1. Goals / non-goals

**Goals**

- G1. Board-driven factory: cards in a *Ready* lane flow Ready → Building → QA → Review → Done (or Blocked) with zero human steps on the happy path, and every transition is journaled.
- G2. Swappable providers: one dispatcher, adapters for **local** (file-backed, for tests/offline), **GitHub** (Issues + Projects v2, PRs), **GitLab** (Issue Boards via scoped labels, MRs), **Jira + Bitbucket** (Jira board, Bitbucket PRs).
- G3. Role-scoped agents: each lane binds one agent profile (`model`, `thinking`, `tools`, `skills`, budgets). Only that profile's skills and tools are injected into the omp child.
- G4. Deterministic authority boundaries: a worker *cannot* merge, approve, or touch the board — enforced by credentials and tool policy, not by prompt wording.
- G5. Evidence-first: every lane exit is a `gk gate` verdict over content-addressed evidence; proof is posted to the card; the full history verifies with `gk run verify --evidence`.
- G6. Human override from the board: a `factory:halt` label (or moving the card out of its lane) stops the card's omp process tree within one poll interval.

**Non-goals (load-bearing, see `docs/honest-gaps.md`)**

- N1. **No daemon / broker.** The dispatcher is `gk factory tick` — one idempotent reconcile pass. Cadence comes from `gk schedule emit` (cron / launchd / GitHub Actions) or a foreground `gk factory run --interval` loop that just calls `tick`. This keeps the "not a work-queue broker" boundary.
- N2. **`gk` still never calls an LLM.** All model work happens in spawned omp children.
- N3. No webhook server in v1 (polling only; webhooks are a later optimization that would call the same `tick`).
- N4. No cross-repo cards in v1 (one factory config = one repo).
- N5. `temperature` is not configurable — omp 18.12.6 has no CLI flag for it (§3.3).

## 2. Architecture

```
                ┌──────────────── Issue board (GitHub Projects v2 / GitLab board / Jira) ──────────────┐
                │  Ready │ Building │ In QA │ Under Review │ Blocked │ Done          (+ factory:halt label) │
                └────▲───────▲──────────▲────────────▲─────────────────────────────────────────────────┘
                     │ IIssueBoardProvider (poll, move, comment, halt check)
┌────────────────────┴──────────────────────────────────────────────────────────────────────────────┐
│ gk factory tick   (src/factory/dispatcher.ts — one reconcile pass, no daemon)                      │
│   1 load .omp/factory.yaml (zod)     2 reconcile card journals ↔ board ↔ live pids                │
│   3 halt sweep                       4 advance finished lanes (gate → move/comment/PR/merge)      │
│   5 claim Ready cards up to max_parallel   6 dispatch lane runs (detached gk exec children)       │
└────┬──────────────────────────┬─────────────────────────────┬─────────────────────────────────────┘
     │ IVCSProvider              │ Workspace (local git)        │ LaneRunner
     │ push/PR/checks/merge      │ worktree per card            │ gk run + gk exec --worktree on the
     │ (holds the VCS token)     │ .graphkit/factory/wt/<card>  │ lane graph; omp children spawned with
     ▼                           ▼                              ▼ the lane's AgentProfile
  GitHub / GitLab / Bitbucket   git worktree add -b factory/<card>   omp -p --mode json --model … --skills … --tools …
                                                                    -e .omp/extensions/gk-factory-guard.ts
```

Three planes, three owners:

| Plane | Owner | Holds credentials? | Can call a model? |
|---|---|---|---|
| Control (board, PR, merge) | `gk factory` dispatcher + providers | **yes** (VCS/board tokens) | no |
| Execution (code, tests, review) | omp children per lane | **no** (tokens scrubbed from env) | yes |
| Record (ledger, evidence, card journal) | `gk run` / `gk evidence` / `.graphkit/factory/` | n/a | no |

Agents produce **evidence**; only the dispatcher turns evidence into side effects (push, PR, comment, move, merge). That is the real version of the note's "deterministic boundaries".

## 3. Components

### 3.1 Provider interfaces (`src/factory/providers/types.ts`)

The note's two interfaces are kept, with five changes: (a) local git work moves out of `IVCSProvider` into `Workspace` (branch/worktree creation is never a remote operation); (b) ids are opaque strings everywhere (Jira keys are `PROJ-123`, GitHub Projects item ids are node ids); (c) `getCard` + `listComments` for reconcile; (d) CI status for the babysit step; (e) idempotency markers so a re-run tick never double-posts.

```ts
export type LaneKey = "ready" | "building" | "qa" | "review" | "blocked" | "done";

export interface IssueTask {
  id: string;            // provider-opaque card id (board item id)
  key: string;           // human key: "#412", "PROJ-123"
  title: string;
  description: string;   // markdown body — the spec the agents work from
  labels: string[];
  lane: LaneKey | null;  // null = card is in a column the config doesn't map
  sourceUrl: string;
  updatedAt: string;     // ISO; used for "human moved it" detection
}

export interface CardComment { id: string; body: string; author: string; createdAt: string }

export interface IIssueBoardProvider {
  readonly kind: "local" | "github" | "gitlab" | "jira";
  getCardsInLane(lane: LaneKey): Promise<IssueTask[]>;
  getCard(id: string): Promise<IssueTask | null>;
  moveCardLane(id: string, lane: LaneKey): Promise<void>;
  /** Idempotent: if a comment carrying `marker` exists it is edited, not duplicated. */
  upsertComment(id: string, marker: string, markdown: string): Promise<{ commentId: string }>;
  listComments(id: string): Promise<CardComment[]>;
  addLabel(id: string, label: string): Promise<void>;
  removeLabel(id: string, label: string): Promise<void>;
  /** True when the halt label is present OR the card left the lane the factory last put it in. */
  isTaskHalted(id: string, expectedLane: LaneKey): Promise<boolean>;
}

export type CheckState = "pending" | "success" | "failure" | "none";

export interface IVCSProvider {
  readonly kind: "local" | "github" | "gitlab" | "bitbucket";
  pushBranch(worktreePath: string, branch: string): Promise<void>;
  /** Idempotent on sourceBranch: returns the existing open PR/MR if one exists. */
  openPullRequest(o: { sourceBranch: string; targetBranch: string; title: string; body: string; draft?: boolean })
    : Promise<{ url: string; number: number }>;
  updatePullRequestBody(number: number, body: string): Promise<void>;
  getChecks(number: number): Promise<{ state: CheckState; failing: Array<{ name: string; url: string }> }>;
  mergePR(number: number, method: "squash" | "merge" | "rebase"): Promise<{ sha: string }>;
}

export interface Workspace {
  /** git worktree add .graphkit/factory/wt/<card> -b factory/<card> <base>; reuses an existing one. */
  ensure(cardId: string, baseBranch: string): Promise<{ path: string; branch: string }>;
  remove(cardId: string): Promise<void>;
}
```

Marker format (in every factory comment / PR body): `<!-- gk-factory card=<id> lane=<lane> run=<run-id> kind=<claim|proof|review|halt> -->`.

**Adapter matrix (v1 implementation choices)**

| | local | GitHub | GitLab | Jira + Bitbucket |
|---|---|---|---|---|
| Lanes | `lane` field in `.graphkit/factory/board/<id>.yaml` | Projects v2 single-select **Status** field; `gh project item-list/item-edit` | Scoped labels `factory::<lane>` (board lists keyed on them); REST v4 | Jira workflow transitions (`POST /issue/{key}/transitions`) |
| Cards | YAML files | Issues in the project | Issues | Jira issues |
| Comments | `comments:` array | `gh api repos/{o}/{r}/issues/{n}/comments` | `POST /projects/:id/issues/:iid/notes` | `POST /issue/{key}/comment` |
| PR/MR | local branch only (`number` = monotonic counter) | `gh pr create/view/merge`, `gh pr checks` | `POST /merge_requests`, pipelines API | Bitbucket Cloud REST `pullrequests`, commit statuses |
| Transport | fs | `gh` CLI (already used by repo) | `fetch` + `GITLAB_TOKEN` (no `glab` dependency) | `fetch` + `JIRA_TOKEN`/`BITBUCKET_TOKEN` |

All adapters go through one injectable `exec`/`fetch` seam so unit tests run against recorded fixtures, never the network.

### 3.2 Factory config (`.omp/factory.yaml`)

Lives next to the omp kit so `gk kit install` / `sync-omp` can seed a starter. Validated by `FactoryConfigSchema` (zod, `.strict()` — unknown keys are errors with a hint, so the note's `temperature`/`max_tokens_budget` fail loudly instead of silently doing nothing).

```yaml
version: 1

board:
  provider: github            # local | github | gitlab | jira
  github: { owner: acme, repo: payments, project_number: 7, status_field: Status }
  # gitlab: { host: https://gitlab.internal.corp, project: fintech/core-payment-gateway, label_prefix: "factory::" }
  # jira:   { host: https://acme.atlassian.net, project: PAY, board_id: 4201 }
  lanes:                      # LaneKey -> provider column/label/status name
    ready: Ready
    building: Building
    qa: In QA
    review: Under Review
    blocked: Blocked
    done: Done
  halt_label: factory:halt
  intake_label: factory       # optional: only cards carrying this label are eligible

vcs:
  provider: github            # local | github | gitlab | bitbucket
  base_branch: main
  branch_prefix: factory/
  merge: { method: squash, auto: false, require_checks: true }   # auto:false => park in Done-awaiting-human

dispatch:
  poll_interval: 60s          # used by `gk factory run`; `tick` itself is one pass
  max_parallel: { building: 2, qa: 2, review: 1 }
  max_rounds: 3               # Review/QA BLOCK -> back to Building at most N times, then Blocked
  halt_poll: 15s              # how often a running lane re-checks isTaskHalted
  env_passthrough: [ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY]   # everything else matching *TOKEN*/*KEY* is scrubbed

agents:
  intake:
    model: "@smol"            # omp role selector or provider/model id
    thinking: low
    tools: [read, grep, find, bash]
    skills: [factory-intake, factory-repro-check]
    max_time: 10m
  worker:
    model: "@default"
    thinking: medium
    tools: [read, grep, find, glob, edit, write, bash, lsp, todo]
    skills: [factory-build, factory-dedup-ladder, factory-git-sync, context-docs]
    max_time: 45m
    budget_tokens: 120000
  qa:
    model: "@default"
    thinking: low
    tools: [read, grep, find, bash]
    skills: [factory-scrutiny, factory-proof]
    max_time: 30m
  reviewer:
    model: "@slow"
    thinking: high
    tools: [read, grep, find, bash]
    skills: [factory-adversarial-review, factory-heresy-lint]
    max_time: 20m

qa:
  commands: ["bun run typecheck", "bun run lint", "bun test"]   # project commands factory-scrutiny runs, in order
  ui: null                    # or { command: "bunx playwright test", artifacts: "test-results/" }

lanes:
  ready:    { agent: intake,   graph: factory-intake,   next: building }   # optional triage pass on claim
  building: { agent: worker,   graph: factory-build,    next: qa }
  qa:       { agent: qa,       graph: factory-qa,       next: review }
  review:   { agent: reviewer, graph: factory-review,   next: done }
```

Rules enforced by `gk factory validate`:

- every `lanes.*.agent` exists in `agents`; every `lanes.*.graph` resolves (gallery template name or path) and validates with `gk validate`;
- every skill in `agents.*.skills` resolves to a `SKILL.md` via omp's discovery roots (`<repo>/.omp/skills/<name>/`, ancestor `.omp/skills/`, `~/.omp/agent/skills/`) — `FACTORY_UNKNOWN_SKILL`;
- every tool in `agents.*.tools` is an omp 18.12.6 builtin (`BUILTIN_TOOL_NAMES`) or an extension tool declared under `extensions:` — `FACTORY_UNKNOWN_TOOL`;
- **authority lint** (`FACTORY_AUTHORITY`): no agent may list `github` (omp's builtin GitHub tool), `task` (would let a worker spawn unscoped subagents), or `manage_skill`/`learn` (self-modification is `gk selflearn`'s job); the `reviewer` and `qa` profiles may not list `edit`/`write`;
- required env for the chosen providers is present (names only, never values) — `FACTORY_MISSING_ENV`.

### 3.3 omp invocation — what omp 18.12.6 actually supports

The note's example command uses flags that **do not exist** in omp 18.12.6: `--worktree`, `--context-deferred`, `--issue-id`, `--run <file.ts>`. Verified flags we build on:

| Need | omp 18.12.6 flag | Notes |
|---|---|---|
| headless one-shot | `-p` / `--print` + prompt on stdin | `gk` already pipes via `printf %s "$GK_PROMPT" \| exec omp` (stdin-pipe workaround in `src/exec/spawn.ts`) |
| machine-readable output | `--mode json` | JSON event stream (`message_end`, `turn_end`, …); final text is the last assistant message |
| model per role | `--model <selector>` | role selectors `@default` / `@smol` / `@slow` (prefix `@`, `src/config/model-roles.ts`) or `provider/id` |
| reasoning effort | `--thinking <effort>` | |
| **skill scoping** | `--skills a,b,c` | overrides the `skills.includeSkills` setting for the session (`src/main.ts`); `--no-skills` = none |
| **tool scoping** | `--tools a,b,c` | lowercase builtin names; `normalizeToolNames` canonicalizes `Read`→`read` |
| wall-clock cap | `--max-time 45m` | |
| role prompt | `--append-system-prompt <text>` | replaces today's "prepend agent fragment to the user prompt" |
| no approvals headless | `--approval-mode yolo` | headless children cannot answer prompts |
| no state bleed | `--no-session` | reviewer sees no author scratchpad |
| policy hook | `-e <extension.ts>` | `tool_call` handlers may return `{ block: true, reason }` |
| working dir | spawn `cwd` (or `--cwd`) | worktrees come from gk, not omp |

Real lane invocation (built by `buildPiArgs` from the `AgentProfile`):

```bash
cd .graphkit/factory/wt/412 && printf %s "$GK_PROMPT" | exec omp -p --mode json \
  --model @default --thinking medium \
  --skills factory-build,factory-dedup-ladder,factory-git-sync,context-docs \
  --tools read,grep,find,glob,edit,write,bash,lsp,todo \
  --max-time 45m --approval-mode yolo --no-session \
  --append-system-prompt "$GK_ROLE_PROMPT" \
  -e "$REPO/.omp/extensions/gk-factory-guard.ts"
```

Unverified-until-P0 assumptions (the plan's Task 0 spike pins each with a recorded fixture before anything depends on it): `--mode json` composes with `-p` and stdin; `--append-system-prompt` accepts multi-KB text via argv; `--skills` with an unknown name warns rather than fails; `--approval-mode yolo` suppresses every prompt under `-p`.

### 3.4 Enforcement — four layers, strongest last

1. **Skill scoping** (`--skills`): context hygiene. Keeps irrelevant skill descriptions out of the system prompt. *Not* a security boundary — a skill is instructions, and bash can still run anything.
2. **Tool scoping** (`--tools`): removes whole tool schemas (`edit`/`write` for QA and reviewer, `github`/`task` for everyone).
3. **Guard extension** (`kits/_core/extensions/gk-factory-guard.ts`, new): on `tool_call`, blocks with a reason —
   - `bash` commands matching the deny list: `gh pr (merge|review --approve)`, `gh api .*/merges`, `glab mr (merge|approve)`, `git push` to anything but the card branch, `git push --force`, `git checkout <base>`, `curl … (api.github.com|gitlab|atlassian|bitbucket)`;
   - `edit`/`write` whose resolved path is outside the card worktree (or outside `owns:` globs when the lane graph declares them);
   - every attempt appends `{at, card, lane, tool, reason}` to `.graphkit/factory/guard.jsonl` (surfaced in proof comments).
   Rules come from `GK_FACTORY_POLICY` (JSON in env, written by the dispatcher per lane), so the extension stays a verbatim kit file with no repo imports (same discipline as `gk-subagent.ts`).
4. **Credential isolation**: the dispatcher spawns lane runs with an env built from an allowlist — model-provider keys from `dispatch.env_passthrough` only; `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `JIRA_TOKEN`, `BITBUCKET_*`, `SSH_AUTH_SOCK` are removed; `GIT_TERMINAL_PROMPT=0`. A worker that slips past layer 3 still has nothing to authenticate with. Pushing, PR creation, and merging happen in the dispatcher process.

### 3.5 Card lifecycle (state machine)

```
            claim (tick)                 build MERGE            qa MERGE               review MERGE + checks green
 Ready ───────────────▶ Building ───────────────────▶ In QA ──────────────▶ Under Review ─────────────────────────▶ Done
   ▲                      ▲  │ build BLOCK/fail          │ qa BLOCK                 │ review BLOCK                     (auto merge, or
   │                      │  └────────────┐              │                          │                                   park for human)
   │                      └───── round < max_rounds ◀────┴──────────────────────────┘
   │                                     │ round ≥ max_rounds, budget exceeded, guard storm, or unrecoverable error
   │ human removes halt / moves back     ▼
   └──────────────────────────────── Blocked  (proof comment names the failing criterion)
```

Per-card journal `.graphkit/factory/cards/<id>.json` (atomic tmp+rename inside the existing `withFeatureLock` mkdir lock):

```ts
interface CardJournal {
  card: string; key: string; provider: string;
  lane: LaneKey;                 // lane the factory last put it in (halt detection)
  phase: "claimed" | "running" | "awaiting_advance" | "parked" | "blocked" | "done";
  round: number;                 // completed Review/QA → Building bounces
  branch?: string; worktree?: string; pr?: { number: number; url: string };
  run_id?: string;               // current gk run
  pid?: number;                  // detached lane-run process group leader
  history: Array<{ at: string; from: LaneKey | null; to: LaneKey; run_id?: string; verdict?: "MERGE" | "BLOCK"; note?: string }>;
}
```

`tick` is a pure function of (config, journals, board snapshot, pid liveness) → list of actions, then an executor applies them. Order inside one tick:

1. **Reconcile.** For each journal with `phase: running`: if `pid` is dead and the run has no terminal `gk run end`, mark the run `failed` (`stop_reason: lane_crashed`) → `awaiting_advance`. Cards on the board in a factory lane with no journal → adopt only if they carry a factory claim marker, else leave alone (never steal human-managed cards).
2. **Halt sweep.** For `running` cards, `isTaskHalted(id, journal.lane)` → kill the process group (`SIGTERM`, then `SIGKILL` after 10s), `gk run end failed --note halted`, upsert a `kind=halt` comment, `phase: parked`. The lane run's own `halt_poll` timer does the same check between tick cadences, so stop latency is ≤ `halt_poll`.
3. **Advance.** For `awaiting_advance` cards, read the lane run's gate verdict (`gk gate --json` in the run dir) and apply the transition in the state machine: push branch, open/update PR (body = spec link + evidence table), upsert a `kind=proof` comment, move the card, bump `round`, or move to Blocked. On `review` MERGE: `getChecks` — `pending` → stay (re-check next tick); `failure` → back to Building with the failing check names as the objective delta (this *is* the "babysit-pr" skill, done deterministically); `success` → `mergePR` when `merge.auto`, else leave in Review with a "ready to merge" comment.
4. **Claim.** `getCardsInLane("ready")` (filtered by `intake_label`), oldest `updatedAt` first, up to `max_parallel.building − running(building)`. Claim = journal write under lock → `moveCardLane(building)` → claim comment. A crash between the steps is healed by step 1 on the next tick.
5. **Dispatch.** For each card needing a lane run: `Workspace.ensure` → `gk run start` (graph = lane graph materialized with `{card_key, title, spec, round, prior_findings}` params) → spawn a **detached** `gk factory lane --card <id>` child (its own process group) that runs `gk exec --worktree` with the lane's `AgentProfile` and exits. `tick` returns immediately; the next tick picks up the result.

Mirror to `gk queue`: each claim also `gk queue add`s an item (id `card-<id>`, `acceptance_criteria` = lane evidence keys) so `gk queue status` and existing dashboards see factory work. The board stays the source of truth for *lane*; the journal is the source of truth for *factory state*.

### 3.6 Lane graphs (new gallery templates)

Each lane is a small `software-factory`-style graph so it reuses gates, holdouts, loops, budgets, and evidence unchanged. Every node gets its `agent`/`model`/`tools`/`skills` from the lane's `AgentProfile` (§3.7), so templates stay provider- and model-agnostic.

| Template | Nodes | Evidence keys (gate `required_keys`) |
|---|---|---|
| `factory-intake` | `triage` (read-only) → `repro-check` | `triage_report`, `repro_result` (`reproduced: yes/no/n.a.`) |
| `factory-build` | `scout` (read-only) → `implement` (write, worktree) → `self-check` (tests the author ran) | `research_findings`, `build_report`, `self_check_log` |
| `factory-qa` | `scrutiny` (typecheck/lint/unit, project commands from config) → optional `ui-journey` → `proof` | `test_matrix`, `qa_proof`; holdout `criteria/*.holdout.md` sealed to the eval-gate node |
| `factory-review` | `adversarial-review` (`role: eval-gate`, `--no-session`, inputs = diff + card spec only) → `heresy-lint` (docs vs code invariants) | `review_verdict` (MERGE/BLOCK + findings), `doc_findings` |

QA and review nodes are `no_write` + `role: eval-gate`, so the existing `HOLDOUT_LEAK` validation and `freshness: strict` evidence apply. Build-lane findings from a bounced round are injected as `prior_findings` and via `## Progress so far` (`progress_tail`).

### 3.7 Agent profiles in the engine

New schema `AgentProfileSchema` (`src/factory/config.ts`): `{model, thinking?, tools[], skills[], max_time?, budget_tokens?, approval_mode? = "yolo"}`. `gk factory lane` applies a profile to every node of the lane graph that doesn't set its own value (node-level values win, except `tools`/`skills`, which are **intersected** with the profile — a graph can narrow a role, never widen it).

Engine changes (small, general — benefit plain `gk exec` too):

- `DispatchArgs` gains `skills?: string[]`, `thinking?: string`, `max_time?: string`, `append_system_prompt?: boolean`, `extensions?: string[]`, `env?: Record<string,string>`, `mode_json?: boolean`.
- `buildPiArgs` emits `--skills` when `node.skills` is non-empty (fixes the silent drop in §0.2), `--thinking`, `--max-time`, `-e` per extension, `--mode json`.
- `spawnDispatch` passes a caller-built `env` instead of `{...process.env}` when given, and parses `--mode json` output into `{ output: lastAssistantText, events_path }` (raw stream saved as evidence `omp_events.jsonl`).
- Tool constraint mapping keeps today's semantics but emits lowercase omp names.

### 3.8 Skills shipped with the kit

New skills under `kits/_core/skills/` (generated into `kits/pi` + `.omp/skills` by `gen:kits`/`sync:omp`; claude target gets them too for parity). Each ≤ 200 lines, trigger-cued description, and passes the existing learn admission lint. Names chosen so the user's note maps 1:1 where it described a real workflow:

| Skill | Lane | Replaces note's | Contract |
|---|---|---|---|
| `factory-intake` | intake | `super-collect` | Normalize the card into objective + acceptance criteria; write `triage_report`. (Sentry/PostHog pull is an optional extension, not v1.) |
| `factory-repro-check` | intake | `reproduction-check` | Run the reported repro command; record `repro_result`. |
| `factory-dedup-ladder` | worker | `ponytail-dedup` | Before writing new code: search existing helpers → callers → tests → docs → deps; record what was reused. |
| `factory-build` | worker | — | Implement to acceptance criteria inside the worktree; commit with conventional messages; write `build_report`. |
| `factory-git-sync` | worker | `git-sync` | Rebase on base when the dispatcher reports drift; never push (dispatcher pushes). |
| `context-docs` | worker | `context-docs` | Progressive third-party doc retrieval (read local `node_modules`/vendored docs first, web second). |
| `factory-scrutiny` | qa | `scrutiny-runner` | Run the project's typecheck/lint/test commands (from `factory.yaml qa.commands`), produce `test_matrix`. |
| `factory-ui-journey` | qa (optional) | `playwright-arena` | Only when the repo declares `qa.ui`: run Playwright journeys, attach screenshots/video paths as evidence. |
| `factory-proof` | qa | `proof-publisher` | Render `test_matrix` + evidence digests into the markdown the dispatcher posts. |
| `factory-adversarial-review` | reviewer | `adversarial-review` | Review diff vs card spec with no author context; emit MERGE/BLOCK + findings with file:line. |
| `factory-heresy-lint` | reviewer | `heresy-linter` | Diff touched docs against code; flag invariants the code doesn't implement. |

`hashline-coder` from the note is dropped: anchored edits are omp's own `edit` tool behavior, not something a skill adds. `babysit-pr` is dropped as a skill: CI watching is deterministic and lives in the dispatcher (§3.5 step 3) where it holds the token.

### 3.9 CLI surface (`gk factory`)

| Command | Purpose |
|---|---|
| `gk factory init [--provider local\|github\|gitlab\|jira]` | write a starter `.omp/factory.yaml` + `criteria/` stubs; idempotent |
| `gk factory validate [--json]` | schema + references + authority lint + env presence (§3.2) |
| `gk factory tick [--dry-run] [--json]` | one reconcile pass; `--dry-run` prints planned actions only |
| `gk factory run [--interval 60s]` | foreground loop calling `tick` (SIGINT = finish current tick, exit) |
| `gk factory lane --card <id>` | internal: run one lane for one card (spawned detached by `tick`) |
| `gk factory status [--json]` | per-lane counts, running cards (pid, elapsed, round), parked/blocked with reasons |
| `gk factory halt <card>` / `resume <card>` | local equivalents of the board halt label |
| `gk factory schedule --format gha\|cron\|launchd` | thin wrapper over `gk schedule emit` for `gk factory tick` |

Registered per repo convention: `factory:` entry in `src/cli/command-registry.ts`, `registerFactoryCommand` in `src/cli/app.ts`, `UNKNOWN_FACTORY_SUBCOMMAND` in `scripts/check-cli-parity.ts`, `bun run gen:manifest`, `fullCli` in `tests/unit/cli-trust.test.ts`.

Error codes: `FACTORY_CONFIG`, `FACTORY_UNKNOWN_SKILL`, `FACTORY_UNKNOWN_TOOL`, `FACTORY_AUTHORITY`, `FACTORY_MISSING_ENV`, `FACTORY_PROVIDER` (wrapped adapter error with HTTP status/`gh` stderr), `FACTORY_LOCKED` (tick already running — tick takes `.graphkit/factory/tick.lock`).

## 4. Failure modes & guarantees

| Failure | Behavior |
|---|---|
| Two ticks overlap (cron + manual) | second exits `FACTORY_LOCKED`, exit 0 with `skipped: true` |
| Tick crashes after journal write, before board move | next tick reconcile sees journal `claimed` + card still in Ready → completes the move |
| Lane process dies (OOM, reboot) | dead pid + no `gk run end` → run `failed (lane_crashed)` → counts as a round → Building/Blocked |
| omp hits `--max-time` | `timed_out: true` from spawn → node fail → lane BLOCK with `timeout` note |
| Provider API 5xx / rate limit | action is retried next tick (all actions idempotent via markers / journal); 3 consecutive failures → `factory status` shows `provider_degraded` |
| Human edits the card mid-run | `updatedAt` change on a running card is logged; only lane change or halt label stops it |
| Review bounces forever | `max_rounds` → Blocked; `no_progress_similarity` on findings text across rounds also trips Blocked early |
| Token budget | lane graph `budget.max_tokens` from profile `budget_tokens`; `BUDGET_EXCEEDED` → Blocked |
| Worker tries to merge | guard blocks + logs; even if bypassed, no token in env |

Auditability: every card's runs verify with `gk run verify --evidence`; the proof comment carries run id + evidence sha256 digests so a reviewer can re-check locally.

## 5. Security notes

- Tokens live only in the dispatcher process; lane env is allowlist-built (§3.4).
- Card bodies are untrusted input (prompt injection). They are passed as `## Card spec` data in the brief, never as system prompt; the guard's deny list holds regardless of what the card says. `intake_label` lets a team restrict the factory to cards created/labelled by trusted members.
- `selflearn` stays on but cannot widen a lane: learned skills land under `.omp/skills/` and are only injected if named in a profile's `skills` list.

## 6. Rollout phases

| Phase | Ships | Exit criterion |
|---|---|---|
| P0 | omp contract spike + engine flags (`--skills`, `--thinking`, `--max-time`, `-e`, env, `--mode json`) | recorded omp fixtures; existing `gk exec` tests green; `node.skills` reaches omp |
| P1 | config schema + `validate` + guard extension + skills pack | `gk factory validate` on the starter config; guard unit tests block the deny list |
| P2 | local provider + journal + `tick`/`lane`/`status` + lane templates | full Ready→Done flow on a scratch repo with the local provider, fake-omp and real-omp runs |
| P3 | GitHub adapter (Projects v2 + PRs + checks) | e2e on a sandbox repo/project: one issue to merged PR |
| P4 | GitLab adapter; Jira + Bitbucket adapter | fixture-tested; live e2e when the user provides a sandbox + tokens |
| P5 | docs (`docs/software-factory.md` section, README row, `docs/graphkit.html`), CHANGELOG, release | ci:local green; docs reviewed |
