/**
 * CLI surface metadata, derived — not hand-synced.
 *
 * cliManifest() reads the cac instance after all register*() calls run, so the
 * manifest cannot drift from the registration surface. Leaf entries under
 * action-dispatched group commands ("graph list" etc.) never reach cac — they
 * live in GROUP_SUBCOMMANDS below as name + terse usage; no prose descriptions
 * exist (the old CLI_COMMANDS copy described `graph index` as "Index memory
 * into CBM" when it indexes the repo — wrong, and now deleted).
 */
import type { CAC } from "cac";
import { listTargets } from "../targets/index.js";
import { APP_VERSION } from "../version.js";

export interface CliManifestCommand {
  name: string;
  description: string;
  options: string[];
}

/** One dispatched leaf of a group command: its name and a terse usage line
 *  (args + leaf-specific flags; group-shared flags like --json stay in the
 *  group's Options block). */
interface Leaf {
  name: string;
  usage: string;
}

/**
 * Leaf entries per action-dispatched group command, in dispatch order. cac
 * sees only the group token; these drive group help strings
 * (subcommandsFor/leafUsageFor), unknown-leaf errors, and the parity gate's
 * leaf probes. Keep usage in sync with the if-chains in src/cli/commands/*.ts.
 */
const GROUP_SUBCOMMANDS: Record<string, Leaf[]> = {
  graph: [
    { name: "topologies", usage: "" },
    { name: "list", usage: "" },
    { name: "switch", usage: "<id>" },
    { name: "show", usage: "[id]" },
    { name: "inspect", usage: "<topology>" },
    { name: "new", usage: "<topology>" },
    { name: "ascii", usage: "[graph.yaml]" },
    { name: "svg", usage: "[graph.yaml]" },
    { name: "waves", usage: "[graph.yaml]" },
    { name: "agents", usage: "[graph.yaml]" },
    { name: "index", usage: "[fast|moderate|full]" },
    { name: "search", usage: "<pattern> [project]" },
    { name: "ask", usage: "<question...>" },
    { name: "trace", usage: "<function_name> [project]" },
    { name: "query", usage: "<cypher> [project]" },
  ],
  memory: [
    { name: "index", usage: "[--project <project>]" },
    { name: "trace", usage: "" },
    { name: "touch", usage: "<id>" },
    { name: "recall", usage: "<query...> [--explain] [--html] [--origin <origin>]" },
    { name: "consolidate", usage: "" },
  ],
  models: listTargets().map((t) => ({ name: t.id, usage: "[set --map <k=v,...> | reset]" })),
  template: [
    { name: "pack", usage: "<file> --name <name> [--input <file>] [--force] [--global]" },
    { name: "list", usage: "" },
    { name: "show", usage: "<name>" },
    { name: "materialize", usage: "<name> [--params <json>] [--use]" },
  ],
  run: [
    { name: "start", usage: "[--graph <path>] [--input <k=v>...]" },
    {
      name: "node",
      usage:
        "<node> --status ok|fail|skipped|challenge | --advisor-fired <round> [--wave N] [--agent <id>] [--model <tier>] [--evidence <keys>] [--duration-ms N] [--attempt N] [--notes <text>] [--streak N]",
    },
    { name: "dispatch", usage: "<node> --via task|extension [--pid N] [--attempt N]" },
    { name: "land", usage: "<node> --commit <sha>" },
    { name: "end", usage: "[--status merged|blocked|failed]" },
    { name: "status", usage: "" },
    { name: "resume", usage: "<run-id> [--from-node <id>] [--dry-run] [--force]" },
    { name: "take", usage: "<run-id> [--force]" },
    { name: "round", usage: "<index>" },
    { name: "analyze", usage: "[run-id]" },
  ],
  evidence: [
    { name: "add", usage: "<file> --key <k> [--note <text>] [--graph <file>]" },
    { name: "invalidate", usage: "--key <k> [--note <text>] [--graph <file>]" },
    { name: "report", usage: "[--html] [--graph <file>]" },
  ],
};

/** Space-joined leaf names for a command group — injected into group --help and error hints. */
export function subcommandsFor(group: string): string {
  return (GROUP_SUBCOMMANDS[group] ?? []).map((l) => l.name).join(" ");
}

/** One indented line per leaf — padded name + terse usage/flags. Injected into
 *  the group's cac Examples section (so `gk <group> --help` — and `gk <group>
 *  <leaf> --help`, which cac routes to the group registration, AuditCli F3 —
 *  lists actionable per-leaf usage) and the curated bare-group help. */
export function leafUsageFor(group: string): string {
  const leaves = GROUP_SUBCOMMANDS[group] ?? [];
  const width = Math.max(0, ...leaves.map((l) => l.name.length));
  return leaves.map((l) => `  ${l.name.padEnd(width)}${l.usage ? `  ${l.usage}` : ""}`.trimEnd()).join("\n");
}

/** Groups carrying action-dispatched leaves — exported so help-coverage tests
 *  can assert every registered leaf shows up in its group's help. */
export function groupNames(): string[] {
  return Object.keys(GROUP_SUBCOMMANDS);
}

/** All registered command paths ("group leaf" form), including action-dispatched leaves. */
export function commandPaths(cli: CAC): string[] {
  const top = cli.commands.map((c) => c.name);
  return [
    ...top,
    ...Object.entries(GROUP_SUBCOMMANDS)
      .filter(([g]) => top.includes(g))
      .flatMap(([g, leaves]) => leaves.map((l) => `${g} ${l.name}`)),
  ];
}

/** Derive the manifest object (mirrors cli-manifest.json) from a fully-registered cac instance. */
export function cliManifest(cli: CAC): { cli: string; version: string; commands: CliManifestCommand[] } {
  return {
    cli: "gk",
    version: APP_VERSION,
    commands: cli.commands.map((c) => ({
      name: c.name,
      description: c.description,
      options: c.options.map((o) => o.rawName ?? `--${o.name}`),
    })),
  };
}
