---
name: factory-dedup-ladder
description: Prefer reuse over new code — the escalation ladder from existing utilities to new abstractions, and when duplication is acceptable. Used by the build lane agent.
disable-model-invocation: true
---

# factory dedup ladder

Before writing new code, climb the ladder:

1. **Reuse** — an existing function/module already does this. Import it.
2. **Compose** — two existing pieces + glue solves it.
3. **Extend** — add a parameter/branch to the existing thing (smallest diff).
4. **Extract** — refactor the repeated shape into a shared helper, then use it.
5. **Write new** — only when the steps above genuinely fail.

## When duplication is acceptable

- Three or fewer similar call sites with diverging futures.
- The shared abstraction would need a worse interface than two copies.
- Test code mirroring setup.

## Rules

- Never introduce a new abstraction the card doesn't require.
- If you skip rungs 1–3, say why in the build output `residual_risks`.
