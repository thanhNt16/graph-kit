---
name: factory-git-sync
description: Keep the lane worktree coherent — status hygiene, conventional commits on the lane branch, rebase-onto-base awareness without mutating history. Used by build lane agents.
disable-model-invocation: true
---

# factory git sync

## Process

1. `git status` before and after your work — the diff must contain only card-scoped changes.
2. Commit on the lane branch (`GK_FACTORY_POLICY.branch`): `type(scope): summary (#card-id)`. One commit per logical change; amend nothing.
3. If the base branch has moved (dispatcher notes it in the prompt), merge conflicts are **not** yours to resolve by rewriting history — rebase is denied by policy. Resolve by merging base into your branch only when the prompt instructs it, else flag `drifted: true` in the build output.
4. Never `git push` — the dispatcher pushes.

## Hygiene

- No `node_modules`, build output, or credential files in commits.
- `.gitignore` additions go through the normal edit path — they count as writes.
