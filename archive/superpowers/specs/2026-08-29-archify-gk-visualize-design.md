# Archify-rendered diagrams for `gk:visualize`

**Date:** 2026-08-29
**Status:** Approved for implementation

## Problem

`/gk:visualize` has four modes: an interactive bundled viewer (default), ASCII,
SVG, and Excalidraw. The interactive viewer is ~1,742 lines of TypeScript
(`src/viewer/`) plus a 2.7 MB bundled runtime mirrored into three kits, backed by
~2,417 lines of tests. It produces a live, key-gated `127.0.0.1` canvas that
cannot be shared, attached to a PR, or opened without a running server.

[archify](https://github.com/tt-a1i/archify) (MIT) is a Node diagram renderer
with an agent-facing contract: the model authors a typed JSON IR, archify
validates it against a quality gate and compiles a self-contained HTML artifact
with pan/zoom, search, guided views, and theming. The artifact is a single file —
shareable, reviewable, archivable.

We replace the interactive viewer with archify-rendered HTML as the default mode.

## Decisions

1. **Skill-mode integration, zero gk code changes.** The model reads the graph,
   authors archify IR, and shells to the archify CLI. No new `gk` subcommand, no
   new TypeScript.
2. **Auto-install on first use, with one confirmation.** The skill probes for
   archify; if absent it asks the user once before running
   `npx -y skills add tt-a1i/archify -g`. Declined or failed → fall back to SVG.
3. **Type router.** The archify diagram type is chosen from graph shape rather
   than fixed.
4. **Interactive viewer is deleted**, not kept alongside. Its live-SSE editing
   loop is the cost; the shareable artifact is the benefit. This was raised
   explicitly with the deletion inventory in hand and confirmed.
5. **Reference-backed + structured input.** The skill consumes
   `gk graph waves` for deterministic column assignment and edits a worked IR
   example rather than composing one blank.

### Rejected

- **Deterministic `gk graph archify` subcommand** — mechanical layout, no
  showcase-quality output, and new code to maintain.
- **Vendoring archify into each of the 5 kits** — ~400 files × 5, manual version
  bumps.
- **Detect-and-instruct (no install)** — extra round trip for every new user.
- **Keeping the viewer as a `--live` mode** — two rendering stacks to maintain
  for one visualization skill.

## Design

### 1. Mode set

| Mode | Trigger | Status |
|---|---|---|
| **Archify HTML** | default | new — self-contained, shareable |
| ASCII | `--ascii` | unchanged (`gk graph ascii`) |
| SVG | `--svg` | unchanged (`gk graph svg`), also the archify fallback |
| Excalidraw | `--excalidraw` | unchanged |
| Interactive viewer | — | **deleted** |

### 2. Install and detection

1. Probe for `bin/archify.mjs` under, in order:
   `./node_modules/archify`, `~/.claude/skills/archify`,
   `~/.agents/skills/archify`, `~/.codex/skills/archify`,
   `~/.config/opencode/skill/archify`, `~/.cursor/skills/archify`.
2. Absent → ask the user once, then
   `npx -y skills add tt-a1i/archify -g`.
3. Declined, no network, or `doctor` fails → render with `gk graph svg` and say
   why.

### 3. Type router

| Signal in graph.yaml | archify type |
|---|---|
| any node has `loop:` | `lifecycle` |
| topology is `memory-augmented`, or subgraph/template composition present | `architecture` |
| otherwise (plain DAG) | `workflow` |

### 4. IR authoring

`gk graph waves graph.yaml` emits the topological wave structure with full node
objects (`agent`, `model`, `objective`, `tools`, `depend_on`, `loop`,
`evidence`). The skill maps:

- wave index → `col`
- model tier → `lane` (opus / sonnet / haiku / fable), colors from
  `references/graph-palette.md`
- node id → `label`, agent → `sublabel`, model tier → `tag`
- `depend_on` → edges; `evidence` → dashed edges; `loop` → failure-state
  transition (lifecycle) or emphasis tag (workflow)

`references/archify-ir.md` carries the router table, the mapping, and one
complete worked `workflow` IR built from a real fixture graph. The model edits
that example rather than composing from nothing.

Defaults omitted per the archify authoring contract: `meta.visual_preset`,
`meta.subtitle`, `meta.legend`, `meta.engineering_profile`. Set
`meta.quality_profile: "showcase"`. At most 5 `meta.views`.

### 5. Validate → deliver

```bash
node <archify>/bin/archify.mjs validate <type> <candidate.json> --quality showcase --json
node <archify>/bin/archify.mjs deliver  <type> <candidate.json> <output.html> --quality showcase --json
```

- `validate` after **every** IR edit. Non-zero exit is never success.
- Showcase pass = 9 artifact checks, 0 composition errors, 0 warnings. A
  4-check receipt is basic validation, not acceptance.
- Cap at 5 validate cycles; still failing → deliver at default quality and
  report the warnings rather than thrash.
- IR candidate persists at `.graphkit/diagrams/{name}.archify.json` (editable
  source, same spirit as the `.excalidraw` file).
- Output `.graphkit/diagrams/{name}.html`. Print the path; do not auto-open.

### 6. Kit fan-out

The five `gk-visualize/SKILL.md` copies differ only in the `name` field, the
invocation prefix, and one launcher path. One body, three substitutions:

| Kit | `name` | prefix |
|---|---|---|
| claude | `gk:visualize` | `/gk:visualize` |
| codex, cursor, opencode | `gk-visualize` | `gk-visualize` |
| pi | `gk-visualize` | `visualize` |

`references/archify-ir.md` and `references/graph-palette.md` ship in all five
kits (cursor, codex, and pi gain a `references/` dir).
`kits/opencode/command/gk-visualize.md` description line is updated.

### 7. Viewer deletion

**Delete:**

- `src/viewer/{app,server,view,normalize}.ts` — 1,742 lines
- `scripts/viewer-launch.ts`, `scripts/build-viewer.sh`, `scripts/dagre-entry.ts`
- `kits/{claude,cursor,opencode}/viewer/` — 2.7 MB
- `tests/unit/viewer-{autofit,behavior,dom,drag,flow,normalize,parity}.test.ts`
- `tests/integration/viewer-server.test.ts`
- `tests/helpers/fake-dom.ts` (viewer-only harness)

**Edit:**

- `package.json` — drop `build:viewer`; strip it from `prepack` and `ci:local`.
  Keep `@dagrejs/dagre` (`src/cli/svg.ts` uses it).
- `tests/integration/init-targets.test.ts` — drop the `.opencode/viewer`
  assertion.
- `tests/unit/skills-template-viewer.test.ts` — retarget to skill-file
  assertions without the viewer.
- `README.md` viewer section → archify mode.
- `docs/templates-and-viewer.md` Part III → archify mode. Filename unchanged.

### 8. Verification

- `bun run ci:local` green (typecheck, lint, build, test) — proves no dangling
  imports after deletion.
- End-to-end: install archify, run the skill against
  `tests/fixtures/diamond-with-verification.yaml` — probe → waves → IR →
  `validate` showcase-clean → `deliver` → open the HTML and confirm the diamond
  renders with tier lanes.
- `gk graph svg` and `gk graph ascii` keep passing their existing tests.
