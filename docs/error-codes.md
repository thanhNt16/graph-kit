# Error code catalog

Every `fail` envelope and `GraphKitError` carries a stable machine-readable
`code`. This catalog documents each one with its remediation. The test
`tests/unit/error-codes-doc.test.ts` fails when a code is used in `src/` but
missing here (or vice versa), so the catalog cannot drift from the binary.

Envelope shape (always JSON on stdout, `--json` or human mode):

```json
{ "status": "fail", "error": { "code": "CODE", "message": "…", "details": {} } }
```

Exit code is 1 for every `fail`. Codes are grouped by the subsystem that
emits them.

## Usage / arguments

| Code | Meaning | Fix |
|---|---|---|
| `MISSING_ARG` | A required positional argument is absent | Provide the argument shown in `gk <command> --help` |
| `MISSING_DIR` | `gk new` requires `--dir` | `gk new --dir my-project` |
| `MISSING_NAME` | A required name argument is absent | Provide the name (`gk template pack` etc.) |
| `MISSING_FILE` | A required file argument is absent | Provide the file path |
| `MISSING_PARAMS` | Required template parameters were not supplied | Pass the listed `--param key=value` pairs |
| `BAD_PARAMS` | A parameter value failed validation | Correct the value per the message |
| `PARAM_INVALID` | A template parameter value is missing or invalid | Supply every required parameter with a valid value |
| `INVALID_LIMIT` | `--limit` must be a positive integer | Use an integer ≥ 1 |
| `INVALID_DEPTH` | `--depth` must be a positive integer | Use an integer ≥ 1 |
| `BAD_TARGET` | Unknown host target | One of `claude`, `cursor`, `opencode`, `codex`, `pi` |
| `BAD_STATUS` | Invalid status value for the subcommand | `gk run node` uses `ok\|fail`; `gk run end` uses `merged\|blocked\|failed` |
| `BAD_ADVISOR` | Advisor recording failed validation | The node needs an `advisor:` block, or `--advisor-fired` needs an integer round ≥ 1 |
| `UNKNOWN_TOPOLOGY` | Not a canonical topology name | Run `gk graph topologies` for the list |
| `NOT_IMPLEMENTED` | Pointer stub for a kit-side capability | Use the `/gk:execute` or `/gk:visualize` session skill, or `gk compile` |

## Graph / compiler

| Code | Meaning | Fix |
|---|---|---|
| `GRAPH_FILE_NOT_FOUND` | The graph file does not exist | `gk graph new <topology>` to scaffold, or check the path |
| `SCHEMA_INVALID` | graph.yaml failed schema validation | Fix the fields listed in `details.issues` |
| `VALIDATION_FAILED` | Structural validation produced findings | Fix each finding in `details.findings` |
| `VALIDATE_ERROR` | The validate command itself failed | See the message; usually a read error |
| `COMPILE_ERROR` | Compilation failed | Fix the reported graph problem, then rerun |
| `ASCII_ERROR` | ASCII render failed | See the message; check the graph parses with `gk validate` |
| `SVG_ERROR` | SVG render failed | See the message; check the graph parses with `gk validate` |
| `WAVES_ERROR` | Wave computation failed | See the message |
| `WAVES_INCOMPLETE` | Not all nodes fit a wave (cycle or unreachable) | Fix `depend_on` so the graph is a DAG |
| `SUBGRAPH_TOO_DEEP` | A custom topology nests too deeply | Flatten the `depend_on` chain |
| `SUBGRAPH_TEMPLATE_MISSING` | A referenced subgraph template is missing | Register the template or fix the reference |
| `UNKNOWN_SUBGRAPH` | Referenced subgraph topology is unknown | Use a canonical topology name |
| `RUN_ERROR` | Generic run-command failure (fallback) | See the message for the underlying error |

## Run ledger / resume

| Code | Meaning | Fix |
|---|---|---|
| `RUN_ACTIVE` | A run is already active | `gk run end` first |
| `NO_ACTIVE_RUN` | No active run for this operation | `gk run start --graph graph.yaml` |
| `RUN_NOT_FOUND` | Unknown run id passed to `gk run status <id>` | List every run with `gk run list` |
| `RUN_META_CORRUPT` | The run's meta.json is not valid JSON | Repair or remove the run dir under `.graphkit/runs/` |
| `RESUME_RUN_NOT_FOUND` | Unknown run id (or a pre-ledger run) | List runs with `gk run list`; use a full run id |
| `RESUME_BAD_FROM_NODE` | `--from-node` is not a node of the graph | Use a node id from the graph |
| `RESUME_GRAPH_DRIFT` | The recorded graph changed since the run started | Rerun `gk init`/graph edits, or `--force` to override |
| `RESUME_DERIVED_INVALID` | The pending-only derived graph failed validation | Fix the listed issue in the source graph |
| `WRITE_FAILED` | An atomic write failed (disk, permissions) | Free space / fix permissions; no partial bytes were written |

## Memory

| Code | Meaning | Fix |
|---|---|---|
| `MEMORY_DIR_UNREADABLE` | The memory store exists but cannot be read | Fix permissions on `.graphkit/memory/` |
| `MEMORY_TRACE_FAILED` | The decay pass failed | See the message; often a corrupt entry or unwritable store |
| `MEMORY_TOUCH_FAILED` | Reinforcement failed | See the message; check store permissions |
| `MEMORY_NOT_FOUND` | No memory entry with that id | `gk memory recall` to find real ids |
| `SUGGESTION_NOT_FOUND` | Unknown suggestion id | `gk suggest --json` lists live ids |
| `PATTERN_SCHEMA_VIOLATION` | Generated pattern violated its published schema | Internal invariant — file a bug with the message |
| `SUGGESTION_SCHEMA_VIOLATION` | Generated suggestion violated its schema | Internal invariant — file a bug with the message |

## Templates

| Code | Meaning | Fix |
|---|---|---|
| `TEMPLATE_NOT_FOUND` | No template with that name | `gk template list` shows project/global/gallery templates |
| `TEMPLATE_EXISTS` | A template with that name already exists | Pick another name or remove the old file |
| `TEMPLATE_INVALID` | The template failed schema validation | Fix the fields listed in the message |
| `SOURCE_INVALID` | The source graph.yaml is not valid GraphKit | Fix the YAML/schema issue listed in `details` |
| `BAD_TEMPLATE_NAME` | Name must match `^[a-z0-9]+(?:-[a-z0-9]+)*$` | Use kebab-case names |
| `DIR_NOT_EMPTY` | Scaffold target directory is not empty | Choose an empty directory |
| `MATERIALIZE_ERROR` | Materialization failed | See the message |
| `PACK_ERROR` | Packing a graph into a template failed | Fix the reported graph problem |
| `LIST_ERROR` | Graph/template listing failed | See the message |
| `SHOW_ERROR` | Show failed (session graph or template) | See the message |
| `SWITCH_ERROR` | `gk graph switch` failed | See the message |
| `SVG_ERROR` | SVG render failed | See the message; check the graph parses with `gk validate` |
| `UNKNOWN_TEMPLATE_SUBCOMMAND` | Unknown `gk template` subcommand | See `gk template --help` |
| `NO_ACTIVE_GRAPH` | No active session graph | `gk graph switch <id>` or `gk template materialize --use` |
| `GRAPH_NOT_FOUND` | No session graph with that id | `gk graph list` for available ids |
| `INVALID_SESSION_ID` | Malformed session graph id | Use a full id from `gk graph list` |
| `ACTIVE_POINTER_DANGLING` | The active pointer references a deleted graph | `gk graph switch <id>` to repoint |
| `ACTIVE_POINTER_CORRUPT` | The active pointer file is corrupt | `gk graph switch <id>` to rewrite it |
| `GRAPHKIT_NOT_INITIALIZED` | No `.graphkit/` directory | Run `gk init` first |

## Evidence / gate

| Code | Meaning | Fix |
|---|---|---|
| `EVIDENCE_KEY_NOT_DECLARED` | Key is neither required nor produced by any node | Declare it in `evidence.required_keys` or `nodes.<id>.evidence` |
| `EVIDENCE_KEY_INVALID` | Evidence key is not a portable basename | Use a plain key like `report` (no `/`, `\`, `..`) |
| `EVIDENCE_FILE_MISSING` | The artifact file to add does not exist | Check the path passed to `gk evidence add` |
| `EVIDENCE_TOO_LARGE` | Artifact exceeds the size limit | Raise `evidence_max_bytes` in `.gk.json` (user-set, not agent-set) |
| `EVIDENCE_ERROR` | Evidence command failed | See the message |
| `GATE_BLOCK` | The evidence gate blocked merge | Produce the missing keys listed in `details.missing`, then rerun `gk gate` |
| `GATE_ERROR` | The gate command itself failed | See the message |

## CBM bridge

| Code | Meaning | Fix |
|---|---|---|
| `CBM_UNAVAILABLE` | The CBM bridge cannot start (package unpublished / spawn failed) | Point `CBM_CMD`/`CBM_ARGS` at a local codebase-memory-mcp build; `gk memory recall`/`touch` work without it |

## Kit / inventory

| Code | Meaning | Fix |
|---|---|---|
| `INIT_FAILED` | Kit installation failed | See the message; check write permissions |
| `KIT_SOURCE_MISSING` | The installed binary cannot find its kit tree | Reinstall: the release tarball must be extracted intact (`gk` + `share/gk/kits/`) |
| `KIT_METADATA_INVALID` | Kit metadata.json is malformed | Restore the kit tree (`gk init --force` after reinstall) |
| `RULES_SECTION_MISSING` | Expected rules section absent from the kit | Reinstall the kit (`gk init --force`) |
| `INVENTORY_FAILED` | Inventory scan failed | See the message |
| `UNKNOWN_MEMORY_SUBCOMMAND` | Unknown `gk memory` subcommand | The error lists the available subcommands |
| `UNKNOWN_GRAPH_SUBCOMMAND` | Unknown `gk graph` subcommand | The error lists the available subcommands |
| `UNKNOWN_MODELS_SUBCOMMAND` | Unknown `gk models` subcommand | The error lists the available subcommands |
| `UNKNOWN_RUN_SUBCOMMAND` | Unknown `gk run` subcommand | The error lists the available subcommands |
| `UNKNOWN_EVIDENCE_SUBCOMMAND` | Unknown `gk evidence` subcommand | The error lists the available subcommands |
| `UNKNOWN_TEMPLATE` | Unknown query template (`gk graph query --template`) | `gk graph query --templates` lists them |
| `STATUS_ERROR` | The status command failed | See the message |
