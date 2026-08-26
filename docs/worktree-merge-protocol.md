# Worktree Merge Protocol

When executing graphs with multiple parallel write nodes (`--worktree` mode or "batch the graph"), GraphKit uses git worktrees to give each worker a separate checkout and branch.

This document describes the merge protocol executed after all nodes in a wave complete.

## The Problem

Swarm and concurrent-agent systems commonly experience write collisions: two agents edit the same file or branch simultaneously, corrupting git state or silently overwriting each other's changes.

## The Protocol

GraphKit enforces a strict, fail-fast sequential merge:

```
                  ┌───────────────────┐
                  │ All wave workers  │
                  │ complete branches │
                  └─────────┬─────────┘
                            │
                            ▼
              ┌───────────────────────────┐
              │ Pick next worker branch   │
              │ in declared node order    │
              └─────────────┬─────────────┘
                            │
                            ▼
           ┌─────────────────────────────────┐
           │ git merge --no-commit --no-ff   │
           └────────────────┬────────────────┘
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
          [ Conflict? ]           [ Clean? ]
                │                       │
                │ YES                   ▼
                │           ┌──────────────────────┐
                │           │ Run repo test gate   │
                │           │ (bun test, npm test) │
                │           └──────────┬───────────┘
                │                      │
                │              ┌───────┴───────┐
                │              ▼               ▼
                │          [ Pass? ]       [ Fail? ]
                │              │               │
                │              │ YES           │ NO
                │              ▼               ▼
                │   ┌────────────────────┐ ┌────────────────────┐
                │   │ git commit --no-ed │ │ git merge --abort  │
                │   │ Proceed to next    │ │ Stop & fix / report│
                │   └────────────────────┘ └────────────────────┘
                ▼
      ┌────────────────────┐
      │ git merge --abort  │
      │ Stop the graph     │
      │ Report node/branch │
      └────────────────────┘
```

### Steps

1. **List branches**: Read each worker's branch from `git worktree list`.
2. **Merge sequentially** in declared node order:
   ```bash
   git merge --no-commit --no-ff <branch>
   ```
3. **Handle conflicts immediately**:
   - If any path has unresolved conflicts (`UU` in `git status`):
     - Run `git merge --abort` **immediately**.
     - Stop the graph execution.
     - Report the node ID, branch name, and conflicting files to the user.
     - **Never** hand-resolve mid-run.
     - **Never** proceed to the next merge while in conflict.
   - *Rationale*: Conflicting edits between sibling nodes in the same wave indicate a plan smell. Those nodes should have been sequenced via `depend_on` in `graph.yaml`.
4. **Gate check before commit**:
   - On a clean merge, run the project's test suite / gate check before sealing the commit:
     ```bash
     git commit --no-edit
     ```
   - If tests fail, stop and fix or run `git merge --abort` before continuing.
5. **Cleanup**:
   - Remove worktrees: `git worktree remove <path>`.
   - Keep branch refs until the full graph passes and the user confirms.

## Host Support

This protocol is implemented in the `gk:execute` skill across all supported target kits:

| Kit | Surface | Support |
|---|---|---|
| Claude Code | `kits/claude/skills/gk-execute/SKILL.md` | Full worktree merge |
| Cursor | `kits/cursor/skills/gk-execute/SKILL.md` | Worktree merge + same-tree fallback |
| Codex CLI | `kits/codex/skills/gk-execute/SKILL.md` | Full worktree merge |
| OpenCode | `kits/opencode/skill/gk-execute/SKILL.md` | Full worktree merge |
| Pi / OMP | `kits/pi/skills/gk-execute/SKILL.md` | Full worktree merge (`gk_dispatch_agent`) |
