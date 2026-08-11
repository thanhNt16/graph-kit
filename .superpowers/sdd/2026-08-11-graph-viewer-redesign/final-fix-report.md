# Final Fix Wave Report

## Status

READY. All confirmed IMPORTANT findings and cheap MINOR fixes implemented. Generated JS/MJS remains uncommitted. Claude/Cursor assets remain byte-identical.

## Test-before evidence

Command:

```sh
bun run build:viewer && bun test tests/unit/viewer-dom.test.ts
```

Before production fixes, the new executed tests failed for the expected missing behavior:

- deferred initial fetch created `EventSource` too early (`toHaveLength(0)` failed);
- rejected initial fetch did not reach the expected error/connect behavior (`offline` rejection surfaced);
- retained model filter control reset instead of remaining `sonnet`;
- retained agent filter control reset instead of remaining `Alpha`;
- stale filter state kept the replacement node filtered;
- raw punctuation/whitespace endpoint lookup returned null and connected edge lacked `emph-conn`;
- retained node layer order remained `["a", "b"]` instead of `["b", "a"]`.

Result: 6 new behavior groups red before implementation. The filter group contains separate retained and stale-removal tests; SSE contains separate resolution and rejection tests.

## Changes

- `src/viewer/app.ts`
  - initial HTTP fetch now catches errors, applies the error UI, then connects SSE in `finally`;
  - rebuilt model/agent selects restore valid active filters or clear stale state/control values;
  - edge endpoint data attributes preserve raw schema IDs; obsolete `esc()` removed;
  - every keyed node group is appended in current `keyboardOrderBy()` order, moving retained nodes without replacing identity.
- `tests/helpers/fake-dom.ts`
  - deferred fetch injection;
  - select clearing/value behavior;
  - agent filter and node order harness methods;
  - raw-ID edge lookup without selector interpolation.
- `tests/unit/viewer-dom.test.ts`
  - executed fetch/SSE success and rejection ordering tests;
  - retained/stale model and agent filter update tests;
  - arbitrary punctuation/whitespace endpoint emphasis test;
  - retained identity plus reordered node-layer test.
- `claude/viewer/styles.css`, `cursor/viewer/styles.css`
  - `var(--hairline)` arrow marker fallback;
  - `context-stroke` upgrade under `@supports`;
  - byte-identical copies.

## Verification

```sh
bun run build:viewer && bun test tests/unit/viewer-dom.test.ts
```

Result: build succeeded; 25 pass, 0 fail, 74 assertions.

```sh
bun test tests/unit/viewer-dom.test.ts tests/unit/viewer-parity.test.ts
```

Result: 37 pass, 0 fail, 152 assertions.

```sh
bun run typecheck
```

Result: `tsc --noEmit`, exit 0.

```sh
bun run lint
```

Result: Biome checked 91 files; 0 errors.

```sh
bun run ci:local
```

Result: typecheck, lint, production build, viewer build, full tests all passed; 303 pass, 0 fail, 1010 assertions. CBM parity reported `CBM not configured — skipping`.

```sh
diff -q claude/viewer/styles.css cursor/viewer/styles.css
diff -q claude/viewer/app.js cursor/viewer/app.js
diff -q claude/viewer/dagre.js cursor/viewer/dagre.js
diff -q claude/viewer/index.html cursor/viewer/index.html
```

Result: no differences.

## Commits

- `a8d970653abf0eb361175188681d65f83c51ab05` — `fix: harden live viewer reconciliation`
- Report commit: this document's commit (`HEAD` at delivery; exact hash reported in the final status because a commit cannot contain its own hash).

## Self-review

- Scope matches approved findings; bounded O(P*N), `TIERS`, duplicate source assets, `textNode`, and visible-node policies unchanged.
- No dependency, inline style, inline script, generated JS, or generated MJS added to the commit.
- Error path connects SSE after displaying initial failure.
- Filter rebuild updates state and visible classes after stale values clear.
- Raw endpoint values use DOM attribute APIs; tests avoid unsafe selector construction.
- Reordering uses native `appendChild` move semantics, preserving keyed element identity.
- Remaining concern: CBM parity cannot execute without local CBM configuration; project script explicitly skips it.
