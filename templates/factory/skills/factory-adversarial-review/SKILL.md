---
name: factory-adversarial-review
description: Review the lane diff as a hostile maintainer — hunt regressions, scope creep, missing tests, and authority violations before merge. Used by the review lane agent.
disable-model-invocation: true
---

# factory adversarial review

The diff wants to merge. Your job is to find why it shouldn't.

## Hunt list

1. **Regression** — deleted guards, changed defaults, altered public behavior the card didn't ask for.
2. **Scope creep** — files changed the card didn't imply; drive-by refactors.
3. **Missing test** — new behavior with no regression seed; a bug fix whose repro was never codified.
4. **Authority violation** — anything the worker wasn't allowed to do (provider calls, config edits outside owns).
5. **Convention break** — style/patterns diverging from the file's own neighbors.
6. **Security** — secrets, injection surfaces, unsafe deserialization introduced.

## Output

```
```gk-review
{"verdict": "approve|request-changes", "issues": [{"severity": "blocker|nit", "where": "file.ts:12", "what": "…"}], "praises": ["…"]}
```
```

## Rules

- Read-only. `approve` requires zero blockers. Nits never block alone.
- Review the diff, not the codebase at large — `git diff` against the merge base the prompt names.
