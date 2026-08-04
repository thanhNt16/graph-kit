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
function installOpts(opts: Record<string, unknown>): InstallOptions {
  return { scope: opts?.global ? "global" : "project", force: Boolean(opts?.force), dryRun: Boolean(opts?.dryRun) };
}

export const COMMAND_NAMES = [
  "template list",
  "template inspect",
  "template new",
  "template validate",
  "template render",
  "template install",
  "template diff",
  "template update",
  "template remove",
  "workflow start",
  "workflow next",
  "workflow execute",
  "workflow submit",
  "workflow status",
  "workflow trace",
  "workflow graph",
  "evidence report",
  "manifest generate",
] as const;
export interface CliManifest {
  cli: string;
  version: string;
  commands: Array<{ name: string; options: string[] }>;
}
export function cliManifest(): CliManifest {
  return { cli: "gk", version: VERSION, commands: COMMAND_NAMES.map((name) => ({ name, options: ["--json"] })) };
}
export async function generateCliManifest(directory = process.cwd()): Promise<CliManifest> {
  const manifest = cliManifest();
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "cli-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
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
        case "graph":
          return renderMermaid(await mermaidGraph(await template(a[0]), project(), a[1]));
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
  cli.version(VERSION);
  cli.help();
  registerCommands(cli);
  return { cli };
}
export type Cli = ReturnType<typeof createCli>;
