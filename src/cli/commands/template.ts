import { existsSync, mkdirSync, renameSync as osRenameSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import { GraphSchema } from "../../schemas/graph.schema.js";
import { type GraphTemplate, GraphTemplateSchema, TEMPLATE_NAME_RE } from "../../schemas/template.schema.js";
import { fail, ok } from "../output.js";

// ponytail: DI seam mirroring graph.ts — lets tests simulate a rename failure
// without touching the real filesystem. Restore via _resetWriteSeam.
let wRename: typeof osRenameSync = osRenameSync;
/** @internal test seam — inject rename implementation. */
export function _setWriteSeam(opts: { rename?: typeof osRenameSync }) {
  if (opts.rename) wRename = opts.rename;
}
/** @internal test seam — restore real rename. */
export function _resetWriteSeam() {
  wRename = osRenameSync;
}

function localTemplatesDir(cwd: string): string {
  return join(cwd, ".graphkit", "templates");
}
function globalTemplatesDir(home: string): string {
  return join(home, ".graphkit", "templates");
}
function templatePath(dir: string, name: string): string {
  return join(dir, `${name}.gk.yaml`);
}

/** Resolve a template name against stores, local before global. */
function resolveTemplate(
  cwd: string,
  home: string,
  name: string,
): { path: string; origin: "project" | "global" } | null {
  const local = templatePath(localTemplatesDir(cwd), name);
  if (existsSync(local)) return { path: local, origin: "project" };
  const global = templatePath(globalTemplatesDir(home), name);
  if (existsSync(global)) return { path: global, origin: "global" };
  return null;
}

function readTemplate(path: string): GraphTemplate {
  const raw = readFileSync(path, "utf-8");
  const doc = YAML.parse(raw);
  const parsed = GraphTemplateSchema.safeParse(doc);
  if (!parsed.success) {
    throw new GraphKitError("TEMPLATE_INVALID", `Template at ${path} failed validation`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

/** Build a complete GraphTemplate from a source graph file (zero-parameter). */
function templateFromSource(file: string, name: string): GraphTemplate {
  const raw = readFileSync(file, "utf-8");
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (e) {
    throw new GraphKitError("SOURCE_INVALID", `Source graph is not valid YAML: ${String(e)}`);
  }
  const graph = GraphSchema.safeParse(doc);
  if (!graph.success) {
    throw new GraphKitError("SOURCE_INVALID", "Source graph failed schema validation", {
      issues: graph.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const findings = validateGraph(graph.data, dirname(file));
  if (findings.length > 0) {
    throw new GraphKitError("SOURCE_INVALID", "Source graph has validation findings", { findings });
  }
  return {
    apiVersion: "graphkit.dev/v1",
    kind: "GraphTemplate",
    metadata: {
      name,
      description: graph.data.metadata.description ?? `Template from ${graph.data.metadata.name}`,
      version: 1,
    },
    parameters: {},
    recommendations: { agents: [], skills: [], tools: [], capabilities: [] },
    graph: graph.data,
  };
}

/** Build a complete GraphTemplate from a prepared --input file. */
function templateFromInput(input: string): GraphTemplate {
  const raw = readFileSync(input, "utf-8");
  const doc = YAML.parse(raw);
  const parsed = GraphTemplateSchema.safeParse(doc);
  if (!parsed.success) {
    throw new GraphKitError("TEMPLATE_INVALID", "Prepared template input failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

/** Atomic write: sibling temp file + rename; cleanup temp on rename failure. */
function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  try {
    wRename(tmp, path);
  } catch (e) {
    try {
      // cleanup on failure; ignore errors — temp file may have been created elsewhere
      if (existsSync(tmp)) {
        const { unlinkSync } = require("node:fs");
        unlinkSync(tmp);
      }
    } catch {
      /* best-effort cleanup */
    }
    throw new GraphKitError("WRITE_FAILED", `Failed to write template: ${String(e)}`);
  }
}

type PackResult =
  | { status: string; data: Record<string, unknown>; error?: never }
  | { status: string; error: { code: string; message: string; details?: Record<string, unknown> }; data?: never };

export function runTemplatePack(opts: {
  cwd: string;
  home: string;
  file: string;
  name: string;
  input?: string;
  force?: boolean;
  global?: boolean;
}): PackResult {
  try {
    if (!TEMPLATE_NAME_RE.test(opts.name)) {
      return fail("BAD_TEMPLATE_NAME", `Template name must match ^[a-z0-9]+(?:-[a-z0-9]+)*$`, { name: opts.name });
    }
    const template = opts.input ? templateFromInput(opts.input) : templateFromSource(opts.file, opts.name);
    const dir = opts.global ? globalTemplatesDir(opts.home) : localTemplatesDir(opts.cwd);
    const path = templatePath(dir, opts.name);
    if (existsSync(path) && !opts.force) {
      return fail("TEMPLATE_EXISTS", `Template "${opts.name}" already exists at ${path}. Use --force to overwrite.`);
    }
    const content = YAML.stringify(template);
    atomicWrite(path, content);
    return ok({
      name: opts.name,
      origin: opts.global ? "global" : "project",
      path,
      parameterCount: Object.keys(template.parameters).length,
      recommendationCount:
        template.recommendations.agents.length +
        template.recommendations.skills.length +
        template.recommendations.tools.length +
        template.recommendations.capabilities.length,
    });
  } catch (e) {
    return e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("PACK_ERROR", String(e));
  }
}

export function runTemplateList(opts: { cwd: string; home: string }): {
  status: string;
  data: { templates: Array<Record<string, unknown>> };
} {
  const byName = new Map<string, { path: string; origin: "project" | "global" }>();
  // Global first so project origins overwrite → project wins.
  const globalDir = globalTemplatesDir(opts.home);
  if (existsSync(globalDir)) {
    for (const entry of readDir(globalDir)) {
      if (!entry.endsWith(".gk.yaml")) continue;
      const name = entry.slice(0, -".gk.yaml".length);
      byName.set(name, { path: templatePath(globalDir, name), origin: "global" });
    }
  }
  const localDir = localTemplatesDir(opts.cwd);
  if (existsSync(localDir)) {
    for (const entry of readDir(localDir)) {
      if (!entry.endsWith(".gk.yaml")) continue;
      const name = entry.slice(0, -".gk.yaml".length);
      byName.set(name, { path: templatePath(localDir, name), origin: "project" });
    }
  }

  const templates: Array<Record<string, unknown>> = [];
  for (const [name, { path, origin }] of byName) {
    const t = readTemplate(path);
    templates.push({
      name,
      description: t.metadata.description,
      version: t.metadata.version,
      origin,
      shadowed: origin === "project" && existsSync(templatePath(globalDir, name)),
    });
  }
  templates.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return ok({ templates });
}

/** Levenshtein-ish close-match scoring for unknown-name suggestions. */
function closeMatches(name: string, available: string[]): string[] {
  const scored = available
    .map((candidate) => ({ candidate, score: levenshtein(name, candidate) }))
    .sort((a, b) => a.score - b.score);
  return scored
    .slice(0, 3)
    .filter((s) => s.score <= 3)
    .map((s) => s.candidate);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

type ShowResult =
  | { status: string; data: Record<string, unknown>; error?: never }
  | { status: string; error: { code: string; message: string; details?: Record<string, unknown> }; data?: never };

export function runTemplateShow(opts: { cwd: string; home: string; name: string }): ShowResult {
  try {
    if (!TEMPLATE_NAME_RE.test(opts.name)) {
      return fail("BAD_TEMPLATE_NAME", `Template name must match ^[a-z0-9]+(?:-[a-z0-9]+)*$`, { name: opts.name });
    }
    const resolved = resolveTemplate(opts.cwd, opts.home, opts.name);
    if (!resolved) {
      // Enumerate all available names for suggestions.
      const list = runTemplateList({ cwd: opts.cwd, home: opts.home });
      const available = list.data.templates.map((t) => String(t.name));
      return fail("TEMPLATE_NOT_FOUND", `Unknown template "${opts.name}"`, {
        closeMatches: closeMatches(opts.name, available),
        available,
      });
    }
    const t = readTemplate(resolved.path);
    return ok({
      name: opts.name,
      origin: resolved.origin,
      path: resolved.path,
      description: t.metadata.description,
      version: t.metadata.version,
      parameterCount: Object.keys(t.parameters).length,
      recommendationCount:
        t.recommendations.agents.length +
        t.recommendations.skills.length +
        t.recommendations.tools.length +
        t.recommendations.capabilities.length,
    });
  } catch (e) {
    return e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("SHOW_ERROR", String(e));
  }
}

// Small indirection so list can read a directory without importing readdirSync twice.
function readDir(dir: string): string[] {
  const { readdirSync } = require("node:fs");
  return readdirSync(dir);
}

export function registerTemplateCommands(cli: CAC) {
  const cwd = () => process.cwd();
  const home = () => homedir();

  // Note: cac (6.x) matches commands by a single leading token, so git-style
  // multi-word commands ("template pack") never dispatch. Use one `template`
  // command with action-based subcommand dispatch, mirroring `graph`.
  cli
    .command("template <subcommand> [args...]", "Package, list, and inspect reusable GraphTemplates")
    .option("--name <name>", "Template name (required for pack)")
    .option("--global", "Write to the user-global store")
    .option("--force", "Overwrite an existing template")
    .option("--input <file>", "Prepared complete GraphTemplate input file")
    .option("--json", "JSON output (always emitted; flag accepted for parity)")
    .action((subcommand, args, opts) => {
      const argAt = (i: number): string | undefined =>
        Array.isArray(args) ? args[i] : i === 0 ? (args as string) : undefined;
      if (subcommand === "pack") {
        const file = argAt(0);
        if (!file) {
          console.log(JSON.stringify(fail("MISSING_FILE", "template pack requires a <file> argument")));
          process.exit(1);
          return;
        }
        if (!opts.name) {
          console.log(JSON.stringify(fail("MISSING_NAME", "--name is required")));
          process.exit(1);
          return;
        }
        const res = runTemplatePack({
          cwd: cwd(),
          home: home(),
          file,
          name: opts.name,
          input: opts.input,
          force: opts.force,
          global: opts.global,
        });
        console.log(JSON.stringify(res));
        if (res.status === "fail") process.exit(1);
        return;
      }
      if (subcommand === "list") {
        const res = runTemplateList({ cwd: cwd(), home: home() });
        console.log(JSON.stringify(res));
        return;
      }
      if (subcommand === "show") {
        const name = argAt(0);
        if (!name) {
          console.log(JSON.stringify(fail("MISSING_NAME", "template show requires a <name> argument")));
          process.exit(1);
          return;
        }
        const res = runTemplateShow({ cwd: cwd(), home: home(), name });
        console.log(JSON.stringify(res));
        if (res.status === "fail") process.exit(1);
        return;
      }
      console.log(
        JSON.stringify(
          fail("UNKNOWN_TEMPLATE_SUBCOMMAND", `Unknown template subcommand "${subcommand}"`, {
            available: ["pack", "list", "show"],
          }),
        ),
      );
      process.exit(1);
    });
}
