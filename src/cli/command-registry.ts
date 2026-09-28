/**
 * CLI surface metadata, derived — not hand-synced.
 *
 * cliManifest() reads the cac instance after all register*() calls run, so the
 * manifest cannot drift from the registration surface. Leaf names under
 * action-dispatched group commands ("graph list" etc.) never reach cac — they
 * live in GROUP_SUBCOMMANDS below as names only; descriptions for leaves do
 * not exist anywhere (the old CLI_COMMANDS copy described `graph index` as
 * "Index memory into CBM" when it indexes the repo — wrong, and now deleted).
 */
import type { CAC } from "cac";
import { listTargets } from "../targets/index.js";
import { APP_VERSION } from "../version.js";

export interface CliManifestCommand {
  name: string;
  description: string;
  options: string[];
}

/**
 * Leaf names per action-dispatched group command, in dispatch order. cac sees
 * only the group token; these names drive group help strings, unknown-leaf
 * errors, and the parity gate's leaf probes. Keep in sync with the if-chains
 * in src/cli/commands/*.ts.
 */
const GROUP_SUBCOMMANDS: Record<string, string[]> = {
  graph: [
    "topologies",
    "list",
    "switch",
    "show",
    "inspect",
    "new",
    "ascii",
    "svg",
    "waves",
    "agents",
    "index",
    "search",
    "ask",
    "trace",
    "query",
  ],
  memory: ["index", "trace", "touch", "recall", "consolidate"],
  models: listTargets().map((t) => t.id),
  template: ["pack", "list", "show", "materialize"],
  run: ["start", "node", "dispatch", "land", "end", "status", "resume", "take", "round", "analyze"],
  evidence: ["add", "report"],
};

/** Space-joined leaf names for a command group — injected into group --help and error hints. */
export function subcommandsFor(group: string): string {
  return (GROUP_SUBCOMMANDS[group] ?? []).join(" ");
}

/** All registered command paths ("group leaf" form), including action-dispatched leaves. */
export function commandPaths(cli: CAC): string[] {
  const top = cli.commands.map((c) => c.name);
  return [
    ...top,
    ...Object.entries(GROUP_SUBCOMMANDS)
      .filter(([g]) => top.includes(g))
      .flatMap(([g, leaves]) => leaves.map((l) => `${g} ${l}`)),
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
