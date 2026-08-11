/**
 * Single source of truth for the gk CLI command surface.
 *
 * `cli-manifest.json` at the package root is the generated artifact mirroring
 * this list; the parity gate (scripts/check-cli-parity.ts) verifies the built
 * `dist/index.js` exposes exactly these commands. Keep this list in sync with
 * the register*() calls in src/index.ts.
 */
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
  {
    path: "compile",
    description: "Compile graph.yaml to a .workflow.js script",
    options: ["--output <path>", "--json"],
  },
  { path: "graph list", description: "List canonical topologies", options: ["--json"] },
  { path: "graph inspect", description: "Inspect a topology's config keys", options: ["--json"] },
  { path: "graph new", description: "Emit a graph.yaml template for a topology", options: ["--json"] },
  { path: "graph ascii", description: "Render an ASCII diagram", options: ["--json"] },
  { path: "graph svg", description: "Render an SVG export", options: ["--json"] },
  { path: "graph waves", description: "Output topological wave structure", options: ["--json"] },
  { path: "graph index", description: "Index memory into CBM", options: ["--json"] },
  { path: "graph search", description: "Search the CBM memory graph", options: ["--json"] },
  { path: "graph trace", description: "Trace calls/callees in the CBM graph", options: ["--json"] },
  { path: "graph query", description: "Run a Cypher query against the CBM graph", options: ["--json"] },
  {
    path: "memory index",
    description: "Index .graphkit/memory/ into the CBM memory project",
    options: ["--project <project>", "--json"],
  },
  {
    path: "template pack",
    description: "Package a graph.yaml as a reusable GraphTemplate",
    options: ["--name <name>", "--global", "--force", "--input <file>"],
  },
  { path: "template list", description: "List packaged templates", options: ["--json"] },
  { path: "template show", description: "Show a packaged template", options: ["--json"] },
  {
    path: "inventory",
    description: "Inventory installed agents, skills, tools, and MCP servers",
    options: ["--target <target>", "--json"],
  },
];

/** Return the manifest object (mirrors cli-manifest.json). */
export function cliManifest(): { cli: string; version: string; commands: CliManifestCommand[] } {
  return {
    cli: "gk",
    version: "0.2.0",
    commands: CLI_COMMANDS.map((c) => ({ name: c.path, description: c.description, options: c.options })),
  };
}
