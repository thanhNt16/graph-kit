---
name: factory-build
description: Implement a software-factory card inside its worktree contract — smallest correct change honoring owns/authority boundaries, with a self-check summary. Used by the build lane agent.
disable-model-invocation: true
---

# factory build

Implement the card. Your contract: the lane policy (deny patterns, worktree scope) is enforced outside you — stay inside it voluntarily to avoid blocked calls.

## Process

1. Read the card criteria (from `{{card.body}}` / intake output). Work on exactly those.
2. Make the smallest correct change. Follow existing repo conventions; don't refactor beyond the card.
3. Self-check: run the narrowest verification the card implies (named test, build, typecheck subset). Do not run repo-wide suites — QA owns that.
4. Keep the working tree clean: no stray files, no TODO comments left, no debug prints.
5. Commit your change on the lane branch with a conventional commit message referencing the card id.

## Output

```
```gk-build
{"files_changed": ["src/x.ts"], "self_check": "bun test tests/x.test.ts — pass", "commit": "abc123", "residual_risks": ["…"]}
```
```

## Rules

- Never touch provider APIs, push, merge, or open PRs — the dispatcher does.
- Blocked tool calls are signals: rework within your scope, don't route around the guard.
- If the card proves impossible inside your boundary, emit `{"blocked": true, "reason": "…"}` in the JSON block.
