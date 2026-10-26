/** Vendored copy of omp 18.12.6 `src/tools/builtin-names.ts` BUILTIN_TOOL_NAMES.
 *  Used by `gk factory validate` to check agent-profile `tools:` entries —
 *  unknown names are a config bug omp silently ignores at runtime (CONTRACT.md
 *  probe 3 shows the same for skills). Regenerate by diffing against
 *  `@oh-my-pi/pi-coding-agent` `src/tools/builtin-names.ts` on version bumps. */
export const OMP_BUILTIN_TOOLS = [
  "read",
  "bash",
  "edit",
  "ast_grep",
  "ast_edit",
  "ask",
  "debug",
  "ida",
  "eval",
  "github",
  "glob",
  "grep",
  "find",
  "lsp",
  "checkpoint",
  "rewind",
  "context_notes",
  "new_context",
  "security_scan",
  "task",
  "wait",
  "todo",
  "web_search",
  "write",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
] as const;

/** Tools that reach outside the code boundary: provider APIs, sub-agent
 *  dispatch, and skill mutation. Forbidden in every factory agent profile —
 *  provider writes are the dispatcher's job, task/manager bypass isolation. */
export const FACTORY_FORBIDDEN_TOOLS = new Set(["github", "task", "manage_skill", "learn"]);

/** Write-capable tools; forbidden in QA and review lane profiles. */
export const FACTORY_WRITE_TOOLS = new Set(["edit", "write", "ast_edit", "checkpoint", "rewind", "memory_edit"]);
