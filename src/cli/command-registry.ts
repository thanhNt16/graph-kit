/**
 * Single source of truth for the gk CLI command surface.
 *
 * `cli-manifest.json` at the package root is the generated artifact mirroring
 * this list; the parity gate (scripts/check-cli-parity.ts) verifies the built
 * `dist/index.js` exposes exactly these commands. Keep this list in sync with
 * the register*() calls in src/index.ts.
 */
import { APP_VERSION } from "../version.js";

export interface CliManifestCommand {
  name: string;
  description: string;
  options: string[];
}

/** Registered command paths, in the form used to invoke them ("parent leaf"). */
export const CLI_COMMANDS: { path: string; description: string; options: string[] }[] = [
  {
    path: "init",
    description: "Install the GraphKit kit into the current project",
    options: ["--json", "--force", "--target <target>"],
  },
  {
    path: "new",
    description: "Scaffold a new project with the GraphKit kit",
    options: ["--dir <dir>", "--json", "--target <target>"],
  },
  { path: "validate", description: "Validate a graph.yaml", options: ["--json"] },
  { path: "status", description: "Summarize active graph run and evidence coverage", options: ["--json"] },
  {
    path: "doctor",
    description: "One-shot environment check (version, kit source, .graphkit dir, graph.yaml, CBM bridge, PATH shadow)",
    options: ["--json"],
  },
  { path: "execute", description: "Execute a graph.yaml (not yet implemented)", options: ["--json", "--worktree"] },
  { path: "visualize", description: "Visualize a graph.yaml (not yet implemented)", options: ["--json"] },
  {
    path: "gate",
    description: "Deterministic evidence gate: MERGE/BLOCK over required evidence keys",
    options: ["--json"],
  },
  {
    path: "compile",
    description: "Compile graph.yaml to a .workflow.js script",
    options: ["--output <path>", "--json"],
  },
  { path: "graph list", description: "List session graphs", options: ["--json"] },
  { path: "graph switch", description: "Switch active session graph", options: ["--json"] },
  { path: "graph show", description: "Show a session graph (default active)", options: ["--json"] },
  { path: "graph topologies", description: "List canonical topologies", options: ["--json"] },
  { path: "graph inspect", description: "Inspect a topology's config keys", options: ["--json"] },
  { path: "graph new", description: "Emit a graph.yaml template for a topology", options: ["--json"] },
  { path: "graph ascii", description: "Render an ASCII diagram", options: ["--json"] },
  { path: "graph svg", description: "Render an SVG export", options: ["--json"] },
  { path: "graph waves", description: "Output topological wave structure", options: ["--json"] },
  { path: "graph index", description: "Index memory into CBM", options: ["--json"] },
  { path: "graph search", description: "Search the CBM memory graph", options: ["--limit <n>", "--json"] },
  {
    path: "graph ask",
    description: "Ask a natural-language question (routed to the right CBM primitive)",
    options: ["--limit <n>", "--depth <n>", "--json"],
  },
  { path: "graph trace", description: "Trace calls/callees in the CBM graph", options: ["--depth <n>", "--json"] },
  {
    path: "graph query",
    description: "Run a Cypher query against the CBM graph",
    options: ["--template <name>", "--templates", "--json"],
  },
  {
    path: "memory index",
    description: "Index .graphkit/memory/ into the CBM memory project",
    options: ["--project <project>", "--json"],
  },
  {
    path: "memory trace",
    description: "ACT-R score + expire .graphkit/memory/ entries (decay pass)",
    options: ["--json"],
  },
  {
    path: "memory touch",
    description: "Reinforce a memory (bump use_count/last_used_at) so decay keeps it",
    options: ["--json"],
  },
  {
    path: "memory recall",
    description: "Query .graphkit/memory (keyword×salience + validity filters); reinforces survivors",
    options: ["--json"],
  },
  {
    path: "memory consolidate",
    description: "Derive patterns, suggestions, and links from the run ledger",
    options: ["--json"],
  },
  {
    path: "template pack",
    description: "Package a graph.yaml as a reusable GraphTemplate",
    options: ["--name <name>", "--global", "--force", "--input <file>"],
  },
  { path: "template list", description: "List packaged templates", options: ["--json"] },
  { path: "template show", description: "Show a packaged template", options: ["--json"] },
  {
    path: "template materialize",
    description: "Materialize a template into a session graph",
    options: ["--params <json>", "--use", "--json"],
  },
  {
    path: "inventory",
    description: "Inventory installed agents, skills, tools, and MCP servers",
    options: ["--target <target>", "--json"],
  },
  { path: "models cursor", description: "Show the Cursor model mapping", options: ["--json"] },
  { path: "models cursor set", description: "Set a Cursor model override", options: ["--map <k=v,...>", "--json"] },
  { path: "models cursor reset", description: "Remove Cursor model overrides", options: ["--json"] },
  { path: "run start", description: "Start a run and write the ledger entry", options: ["--graph <path>", "--json"] },
  {
    path: "evidence add",
    description: "Record a typed artifact against an evidence key",
    options: ["--key <k>", "--node <n>", "--note <text>", "--json"],
  },
  {
    path: "evidence report",
    description: "Criterion-first evidence report (markdown, or --html page)",
    options: ["--html", "--json"],
  },
  {
    path: "run node",
    description: "Append a node trace line to the active run",
    options: [
      "--status <status>",
      "--wave <n>",
      "--agent <agent>",
      "--model <model>",
      "--evidence <keys>",
      "--duration-ms <n>",
      "--notes <text>",
      "--json",
    ],
  },
  {
    path: "run end",
    description: "Finalize the active run and append to index.jsonl",
    options: ["--status <status>", "--json"],
  },
  { path: "run status", description: "Show the active run directory", options: ["--json"] },
  {
    path: "run resume",
    description: "Derive a pending-only session graph from a failed/interrupted run and start a child run",
    options: ["--from-node <id>", "--dry-run", "--force", "--json"],
  },
  {
    path: "suggest",
    description: "Show ranked workflow suggestions from memory",
    options: ["--dismiss <id>", "--all", "--json"],
  },
];

/** Return the manifest object (mirrors cli-manifest.json). */
export function cliManifest(): { cli: string; version: string; commands: CliManifestCommand[] } {
  return {
    cli: "gk",
    version: APP_VERSION,
    commands: CLI_COMMANDS.map((c) => ({ name: c.path, description: c.description, options: c.options })),
  };
}

/** Space-joined leaf names for a command group — injected into group --help and error hints. */
export function subcommandsFor(group: string): string {
  return CLI_COMMANDS.filter((c) => c.path.startsWith(`${group} `))
    .map((c) => c.path.split(" ")[1])
    .join(" ");
}

/**
 * One line per subcommand (name + description) for a group's `--help` Examples
 * section. cac's help omits command descriptions, so `gk graph --help` used to
 * show LESS than bare `gk graph` — this makes the documented discovery route
 * the richest one.
 */
export function subcommandHelpFor(group: string): string {
  const leaves = CLI_COMMANDS.filter((c) => c.path.startsWith(`${group} `));
  const nameW = Math.max(...leaves.map((c) => c.path.length));
  return leaves.map((c) => `$ gk ${c.path.padEnd(nameW)}  ${c.description.split("\n")[0]}`).join("\n");
}

/** Levenshtein distance, small-n — "did you mean" support for CLI typos. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.length = 0;
    prev.push(...cur);
  }
  return prev[b.length];
}

/** Closest known top-level command for a mistyped one, or null when nothing is close. */
export function suggestCommand(input: string): string | null {
  const names = [...new Set(CLI_COMMANDS.map((c) => c.path.split(" ")[0]))];
  let best: { name: string; d: number } | null = null;
  for (const name of names) {
    const d = editDistance(input.toLowerCase(), name);
    if (!best || d < best.d) best = { name, d };
  }
  return best && best.d <= 2 ? best.name : null;
}
