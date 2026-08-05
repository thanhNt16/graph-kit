import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as cacModule from "cac";
import { evidenceReport, mermaidGraph, renderMermaid, traceRun } from "../commands/observability.js";
import {
  diffTemplate,
  inspectTemplate,
  listTemplates,
  newTemplate,
  removeTemplate,
  renderClaudeSkillsForTemplate,
  updateTemplate,
} from "../commands/template.js";
import { executeWorkflow, nextWorkflow, type SubmitSpec, startWorkflow, submitWorkflow } from "../commands/workflow.js";
import { GraphKitError } from "../errors.js";
import { type InstallOptions, installTemplate } from "../templates/installer.js";
import { loadTemplate } from "../templates/loader.js";
import { fail, ok } from "./output.js";

const cac = ((cacModule as { default?: unknown }).default ?? cacModule) as (
  name?: string,
) => ReturnType<typeof cacModule.cac>;
const VERSION = "0.1.0";
const project = () => process.env.GRAPHKIT_PROJECT ?? process.cwd();
const template = (directory: string) => loadTemplate(resolve(directory));

function emit<T>(value: T): void {
  console.log(JSON.stringify(ok(value)));
}
function emitError(error: unknown): void {
  const e =
    error instanceof GraphKitError
      ? error
      : new GraphKitError("SCHEMA_VIOLATION", error instanceof Error ? error.message : String(error));
  console.log(JSON.stringify(fail(e.code, e.message, e.recoverable, e.details)));
  process.exitCode = 1;
}
/** cac throws `(error, argv)` pairs for unknown options / missing values. */
function isCacError(value: unknown): value is [Error, string[]] {
  return Array.isArray(value) && value.length === 2 && value[0] instanceof Error;
}
export function toGraphKitError(error: unknown): GraphKitError {
  if (error instanceof GraphKitError) return error;
  if (isCacError(error)) return new GraphKitError("SCHEMA_VIOLATION", error[0].message);
  return new GraphKitError("SCHEMA_VIOLATION", error instanceof Error ? error.message : String(error));
}
function installOpts(opts: Record<string, unknown>): InstallOptions {
  return { scope: opts?.global ? "global" : "project", force: Boolean(opts?.force), dryRun: Boolean(opts?.dryRun) };
}

/** Single declarative source of truth for every CLI command. */
export interface CommandOptionSpec {
  /** Full flag syntax, e.g. `--inputs <json>` or `--global`. */
  flag: string;
  description: string;
  required?: boolean;
  default?: string | boolean;
}
export interface CommandDescriptor {
  /** Full leaf command path, e.g. `workflow graph`. */
  path: string;
  description: string;
  options: CommandOptionSpec[];
}
export const CLI_COMMANDS: readonly CommandDescriptor[] = [
  { path: "template list", description: "list installed templates", options: [] },
  { path: "template inspect", description: "inspect a template", options: [] },
  {
    path: "template new",
    description: "create a template",
    options: [
      { flag: "--name <name>", description: "template name" },
      { flag: "--version <version>", description: "template version" },
    ],
  },
  { path: "template validate", description: "validate a template", options: [] },
  { path: "template render", description: "render Claude skills", options: [] },
  {
    path: "template install",
    description: "install a template",
    options: [
      { flag: "--global", description: "use global install scope" },
      { flag: "--force", description: "force modified target removal" },
      { flag: "--dry-run", description: "preview mutation" },
    ],
  },
  {
    path: "template diff",
    description: "diff an installed template",
    options: [{ flag: "--global", description: "use global install scope" }],
  },
  {
    path: "template update",
    description: "update a template",
    options: [
      { flag: "--global", description: "use global install scope" },
      { flag: "--force", description: "force modified target removal" },
      { flag: "--dry-run", description: "preview mutation" },
    ],
  },
  {
    path: "template remove",
    description: "remove a template",
    options: [
      { flag: "--global", description: "use global install scope" },
      { flag: "--force", description: "force modified target removal" },
      { flag: "--dry-run", description: "preview mutation" },
    ],
  },
  {
    path: "workflow start",
    description: "start a workflow",
    options: [{ flag: "--inputs <json>", description: "workflow input JSON" }],
  },
  { path: "workflow next", description: "get the next contract", options: [] },
  { path: "workflow execute", description: "execute a deterministic node", options: [] },
  {
    path: "workflow submit",
    description: "submit contract output",
    options: [
      { flag: "--lease <id>", description: "lease ID" },
      { flag: "--work-item <id>", description: "leased work item" },
      { flag: "--node <id>", description: "workflow node" },
      { flag: "--verdict <verdict>", description: "submission verdict" },
      { flag: "--actor <name>", description: "submission actor" },
    ],
  },
  { path: "workflow status", description: "show current run status", options: [] },
  { path: "workflow trace", description: "show events in order", options: [] },
  {
    path: "workflow graph",
    description: "render Mermaid graph",
    options: [{ flag: "--format <format>", description: "graph output format (mermaid)", default: "mermaid" }],
  },
  { path: "evidence report", description: "show evidence report", options: [] },
  { path: "manifest generate", description: "generate CLI manifest", options: [] },
];
export const COMMAND_NAMES = CLI_COMMANDS.map(({ path }) => path);
export const GLOBAL_OPTION_FLAGS = [
  "--json",
  "--inputs <json>",
  "--lease <id>",
  "--work-item <id>",
  "--node <id>",
  "--verdict <verdict>",
  "--actor <name>",
  "--name <name>",
  "--version <version>",
  "--global",
  "--force",
  "--dry-run",
  "--format <format>",
];
export interface CliManifest {
  cli: string;
  version: string;
  commands: Array<{ name: string; description: string; options: string[] }>;
}
export function cliManifest(): CliManifest {
  return {
    cli: "gk",
    version: VERSION,
    commands: CLI_COMMANDS.map(({ path, description, options }) => ({
      name: path,
      description,
      options: [
        "--json",
        ...options.map((o) => (o.default !== undefined ? `${o.flag} (default: ${o.default})` : o.flag)),
      ],
    })),
  };
}

export function manifestText(manifest: CliManifest): string {
  return `${JSON.stringify(manifest, null, 2).replace(/("options": )\[\n([\s\S]*?)\n\s*\]/g, (_match, prefix: string, body: string) => `${prefix}[${(body.match(/"[^"]*"/g) ?? []).join(", ")}]`)}\n`;
}
export async function generateCliManifest(directory = process.cwd()): Promise<CliManifest> {
  const manifest = cliManifest();
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "cli-manifest.json"), manifestText(manifest));
  return manifest;
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value; // human action string, not JSON
    }
  }
  return value ?? {};
}
function submitOutput(raw: unknown): unknown {
  return typeof raw === "string" && !raw.trim().startsWith("{") ? raw : parseJson(raw);
}
function submitSpec(opts: Record<string, unknown>): SubmitSpec {
  return {
    lease: opts?.lease as string,
    work_item: opts?.workItem as string,
    node: opts?.node as string,
    verdict: opts?.verdict as SubmitSpec["verdict"],
    actor: opts?.actor as string,
  };
}

function registerCommands(cli: ReturnType<typeof cac>): void {
  const handle =
    (handler: (subcommand: string, opts: Record<string, unknown>, args: string[]) => unknown) =>
    (subcommand: string, args: string[], opts: Record<string, unknown>) => {
      const a = args ?? [];
      return Promise.resolve(handler(subcommand, opts ?? {}, a))
        .then(emit)
        .catch(emitError);
    };
  cli.command("template [subcommand] [...args]", "template commands").action(
    handle(async (subcommand, opts, a) => {
      switch (subcommand) {
        case "list":
          return listTemplates();
        case "inspect":
          return inspectTemplate(resolve(a[0]));
        case "validate":
          return (await inspectTemplate(resolve(a[0]))).issues;
        case "new":
          return newTemplate(resolve(a[0]), String(opts.name ?? "new-template"), String(opts.version ?? "1.0.0"));
        case "render":
          return renderClaudeSkillsForTemplate(resolve(a[0]));
        case "install":
          return installTemplate(resolve(a[0]), installOpts(opts));
        case "diff":
          return diffTemplate(a[0], a[1], installOpts(opts));
        case "update":
          return updateTemplate(resolve(a[0]), installOpts(opts));
        case "remove":
          return removeTemplate(a[0], a[1], installOpts(opts));
        default:
          throw new GraphKitError("SCHEMA_VIOLATION", `unknown template command '${subcommand}'`);
      }
    }),
  );
  cli.command("workflow [subcommand] [...args]", "workflow commands").action(
    handle(async (subcommand, opts, a) => {
      switch (subcommand) {
        case "start":
          return startWorkflow(
            project(),
            await template(a[0]),
            (parseJson(opts.inputs) as Record<string, unknown>) ?? {},
            a[1],
          );
        case "next":
          return nextWorkflow(project(), await template(a[0]), a[1]);
        case "execute":
          return executeWorkflow(project(), await template(a[0]), a[1]);
        case "submit":
          return submitWorkflow(project(), await template(a[0]), a[1], submitOutput(a[2]), submitSpec(opts));
        case "status":
          return (await import("../runtime/store.js")).resumeRun(project(), a[0]);
        case "trace":
          return traceRun(project(), a[0]);
        case "graph": {
          const format = String(opts.format ?? "mermaid");
          if (format !== "mermaid") throw new GraphKitError("SCHEMA_VIOLATION", `unsupported graph format '${format}'`);
          return renderMermaid(await mermaidGraph(await template(a[0]), project(), a[1]));
        }
        default:
          throw new GraphKitError("SCHEMA_VIOLATION", `unknown workflow command '${subcommand}'`);
      }
    }),
  );
  cli.command("evidence [subcommand] [...args]", "evidence commands").action(
    handle(async (subcommand, _opts, a) => {
      if (subcommand !== "report")
        throw new GraphKitError("SCHEMA_VIOLATION", `unknown evidence command '${subcommand}'`);
      return evidenceReport(project(), a[1], await template(a[0]));
    }),
  );
  cli.command("manifest [subcommand]", "cli contract commands").action(
    handle(async (subcommand, _opts) => {
      if (subcommand !== "generate")
        throw new GraphKitError("SCHEMA_VIOLATION", `unknown manifest command '${subcommand}'`);
      return generateCliManifest(project());
    }),
  );
}

export function createCli() {
  const cli = cac("gk");
  cli.option("--json", "emit the machine result envelope", { default: false });
  cli.option("--inputs <json>", "workflow input JSON");
  cli.option("--lease <id>", "lease ID");
  cli.option("--work-item <id>", "leased work item");
  cli.option("--node <id>", "workflow node");
  cli.option("--verdict <verdict>", "submission verdict");
  cli.option("--actor <name>", "submission actor");
  cli.option("--name <name>", "template name");
  cli.option("--version <version>", "template version");
  cli.option("--global", "use global install scope");
  cli.option("--force", "force modified target removal");
  cli.option("--dry-run", "preview mutation");
  cli.option("--format <format>", "graph output format");
  cli.version(VERSION);
  cli.help();
  registerCommands(cli);
  return { cli };
}
export type Cli = ReturnType<typeof createCli>;
