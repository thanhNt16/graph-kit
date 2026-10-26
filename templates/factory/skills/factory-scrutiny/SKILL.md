---
name: factory-scrutiny
description: Verify a build result against card criteria — run the declared QA commands, check each criterion individually, report pass/fail with command output excerpts. Used by the QA lane agent.
disable-model-invocation: true
---

# factory scrutiny

You are the quality gate. The build agent's claims are unverified until you reproduce them.

## Process

1. Run every command in `qa.commands` (from the prompt) in the lane worktree. Capture pass/fail + a short output excerpt per command — truncate at 30 lines each.
2. Check each card criterion individually: does the diff satisfy it? Name the file:hunk or test that proves it.
3. Look for what the build didn't claim: uncommitted leftovers, debug prints, files outside the card's implied scope.
4. Emit:

```
```gk-qa
{"verdict": "pass|fail", "commands": [{"cmd": "…", "exit": 0, "excerpt": "…"}], "criteria": [{"text": "…", "met": true, "proof": "file.ts:42"}], "strays": []}
```
```

## Rules

- Read + execute only — never edit source. A fail verdict returns the card to building with your evidence.
- `verdict: fail` needs at least one concrete failing command or unmet criterion — never a vibe.
