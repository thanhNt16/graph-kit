---
name: factory-repro-check
description: Reproduce a reported bug before fixing it — write the smallest failing case, confirm it fails, keep it as the regression seed. Used by intake and build lane agents.
disable-model-invocation: true
---

# factory repro check

For bug-class cards: never fix what you can't observe failing.

## Process

1. Find the existing repro path in the card (steps, error text, failing test name).
2. Build the smallest failing case — an existing test, a `bun test` invocation, a script — and run it. Capture the failure verbatim.
3. If it doesn't fail: stop. The card is not reproduced; report `reproduced: false` with what you tried.
4. If it fails: keep the command — it becomes the regression gate. The fix is accepted only when this command passes.

```
```gk-repro
{"reproduced": true, "command": "bun test tests/x.test.ts", "failure_excerpt": "…"}
```
```

## Rules

- Do not fix anything. Observation only.
- No reproduction → the card bounces to blocked, not to a speculative fix.
