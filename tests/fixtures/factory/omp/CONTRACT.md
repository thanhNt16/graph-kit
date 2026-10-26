# omp 18.12.6 contract — verified against real runs

All findings verified by executing `omp` (`@oh-my-pi/pi-coding-agent@18.12.6`,
installed via `bun install -g`) against a deterministic local model: a
`models.yml` `mock` provider (`api: openai-completions`, `baseUrl:
http://127.0.0.1:18923/v1`) backed by a scripted SSE server. Fixtures are the
raw stdout/stderr captured per probe.

| # | Probe | Flags | Fixture | Result |
|---|-------|-------|---------|--------|
| 1 | JSON event stream | `-p --no-session --mode json` | `p1-json-stream.jsonl` | One JSON object per line: `session` → `agent_start` → `turn_start` → `message_start`/`message_update`(`text_start`/`text_delta`/`text_end`) → `message_end` → `turn_end` → `agent_end`. Final assistant text is `agent_end.messages[last].content[].text`; `agent_end.isTerminal`, `yielded` mark completion. |
| 2 | Large system prompt | `--append-system-prompt <6000 chars>` | `p2-append-system-prompt.jsonl` | Accepted via argv, no E2BIG, exit 0. |
| 3 | Unknown skill | `--skills factory-build,does-not-exist` | `p3-unknown-skill.jsonl` | Silent: no warning on stderr, no event in stream, exit 0. **Validator must resolve skill names itself** — typos are invisible at runtime. |
| 4 | Tool exclusion | `--tools read,grep` while model requests `write` | `p4-tools-exclude.jsonl` | `tool_execution_start` fires, then `tool_execution_end` with `isError:true` + `"Tool write not found"`; the file is never created; the turn continues. |
| 5 | Guard extension bash block | `-e guard.ts`, `GK_FACTORY_POLICY` denies `gh pr merge` | `p5-guard-bash-block.jsonl`, `guard.log` in probe dir | Handler returning `{block:true, reason}` produces `tool_execution_end` `isError:true` with the reason as the tool result; command never runs; audit line appended to `log_path`. |
| 5b | Guard path scope (inside) | `-e guard.ts`, write to `<wt>/allowed.txt` | `p5b-write-inside.jsonl` | Allowed; file created. |
| 5c | Guard path scope (outside) | `-e guard.ts`, write outside `worktree` | `p5c-write-outside.jsonl` | Blocked with `isError:true` `"gk-factory: write outside worktree scope"`; file not created. |
| 6 | Time budget | `--max-time 5s`, server delays 30s | `p6-max-time.jsonl` | Process exits ~6s, **exit 1**; final assistant message `stopReason:"aborted"`, `errorMessage:"Deadline exceeded"` on `message_start`/`message_end`/`turn_end`. No distinct "timed_out" event — detect via exit≠0 + `aborted`. |
| 7 | Model roles | `--model @smol / @slow / @default / mock-model` | stderr only | `@smol`,`@slow` resolve to bundled role picks (hit HF provider → 402 w/o credits). `@default` resolves but errors `No API key found for <provider>` without a real key. Bare `mock-model` resolves without provider prefix. |

Additional observations:

- On connection errors omp emits `auto_retry_start {attempt, maxAttempts:10, delayMs}` then retries — flaky-network turns take a while before failing.
- `auto_retry` is a real event type; the event parser must tolerate it and any future unknown `type`.
- `toolCall` content blocks appear in assistant `message.content[]` with `name`/`arguments`; `turn_end.toolResults[]` carries results.
- Guard extension ctx for `tool_call`: `{type:"tool_call", toolCallId, toolName, input}` where `input.command` (bash), `input.path` (write/edit). Confirmed in `src/extensibility/extensions/types.ts` (`ToolCallEvent`, `ToolCallEventResult{block, reason}`).
- No `--temperature`, `--worktree`, `--context-deferred`, `--issue-id`, `--run` flags exist (spec already corrected).
- omp writes state under `~/.omp/agent/` (dbs) even with `--no-session`; `--no-session` only skips transcript persistence.

Re-run: `bun run scripts/omp-contract-probe.ts --model mock/mock-model` (see `~/omp-probe/mock/server.py` for the scripted SSE server used originally; any configured model works but costs tokens).
