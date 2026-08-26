import { existsSync, mkdirSync, renameSync as osRenameSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CAC } from "cac";
import YAML from "yaml";
import { type Graph, validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import { GraphSchema } from "../../schemas/graph.schema.js";
import {
  materializeTemplate as substituteTemplate,
  type GraphTemplate,
  GraphTemplateSchema,
  type TemplateValues,
  TEMPLATE_NAME_RE,
} from "../../schemas/template.schema.js";
import { saveSessionGraph, setActiveGraphId } from "../../store/index.js";
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

type TemplateOrigin = "project" | "global" | "gallery";

/** Bundled templates ship under `<package root>/templates/gallery/`. */
function galleryTemplatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev: src/cli/commands/template.ts -> package root. Bundled: dist/ -> package root.
  for (const rel of ["../../../", "../"]) {
    const dir = join(here, rel, "templates", "gallery");
    if (existsSync(dir)) return dir;
  }
  return join(here, "..", "..", "..", "templates", "gallery");
}

/** Resolve a template name against stores, project > global > bundled gallery. */
function resolveTemplate(
  cwd: string,
  home: string,
  name: string,
): { path: string; origin: TemplateOrigin } | null {
  const local = templatePath(localTemplatesDir(cwd), name);
  if (existsSync(local)) return { path: local, origin: "project" };
  const global = templatePath(globalTemplatesDir(home), name);
  if (existsSync(global)) return { path: global, origin: "global" };
  const builtin = templatePath(galleryTemplatesDir(), name);
  if (existsSync(builtin)) return { path: builtin, origin: "gallery" };
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
  const byName = new Map<string, { path: string; origin: TemplateOrigin }>();
  // Gallery first, then global, then project — later writes overwrite, so the
  // most-specific store wins at the same priority the resolver uses.
  const builtinDir = galleryTemplatesDir();
  if (existsSync(builtinDir)) {
    for (const entry of readDir(builtinDir)) {
      if (!entry.endsWith(".gk.yaml")) continue;
      const name = entry.slice(0, -".gk.yaml".length);
      byName.set(name, { path: templatePath(builtinDir, name), origin: "gallery" });
    }
  }
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
      shadowed:
        origin === "project"
          ? existsSync(templatePath(globalDir, name))
          : origin === "gallery"
            ? existsSync(templatePath(globalDir, name)) || existsSync(templatePath(localDir, name))
            : false,
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

type MaterializeSuccess = {
  id: string;
  path: string;
  origin: TemplateOrigin;
  graph: Graph;
  active?: string;
};

/**
 * Materialize a resolved template into a session graph: substitute params,
 * run validateGraph, save via the session store, optionally flip --use.
 * Throws GraphKitError before any write on bad input.
 */
export function materializeTemplate(
  name: string,
  params: TemplateValues,
  opts: { cwd?: string; home?: string; use?: boolean } = {},
): MaterializeSuccess {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new GraphKitError("BAD_PARAMS", "Params must be a JSON object", { params });
  }
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new GraphKitError("BAD_TEMPLATE_NAME", `Template name must match ${TEMPLATE_NAME_RE.source}`, {
      name,
    });
  }
  const resolved = resolveTemplate(cwd, home, name);
  if (!resolved) {
    const list = runTemplateList({ cwd, home });
    const available = list.data.templates.map((t) => String(t.name));
    throw new GraphKitError("TEMPLATE_NOT_FOUND", `Unknown template "${name}"`, {
      closeMatches: closeMatches(name, available),
      available,
    });
  }
  const t = readTemplate(resolved.path);

  const missing = Object.entries(t.parameters)
    .filter(([_key, def]) => def.required && !(_key in params))
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new GraphKitError(
      "MISSING_PARAMS",
      `Missing required parameter(s): ${missing.join(", ")}`,
      { missing },
    );
  }

  let graph: Graph;
  try {
    graph = substituteTemplate(t, params);
  } catch (e) {
    if (e instanceof GraphKitError) throw e;
    throw new GraphKitError(
      "PARAM_INVALID",
      e instanceof Error ? e.message : String(e),
      { name },
    );
  }

  const findings = validateGraph(graph, cwd);
  if (findings.length > 0) {
    throw new GraphKitError(
      "VALIDATION_FAILED",
      `Materialized graph failed validation:\n${findings.map((f) => `- [${f.check}] ${f.path}: ${f.message}`).join("\n")}`,
      { findings },
    );
  }

  const saved = saveSessionGraph(graph, name, cwd);
  const out: MaterializeSuccess = { id: saved.id, path: saved.path, origin: resolved.origin, graph };
  if (opts.use) {
    setActiveGraphId(saved.id, cwd);
    out.active = saved.id;
  }
  return out;
}

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
    .command("template <subcommand> [args...]", "Package, list, inspect, and materialize reusable GraphTemplates")
    .option("--name <name>", "Template name (required for pack)")
    .option("--global", "Write to the user-global store")
    .option("--force", "Overwrite an existing template")
    .option("--input <file>", "Prepared complete GraphTemplate input file")
    .option("--params <json>", "JSON object of template parameters (materialize)")
    .option("--use", "Set the active session pointer after materializing")
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
      if (subcommand === "materialize") {
        const name = argAt(0);
        if (!name) {
          console.log(JSON.stringify(fail("MISSING_NAME", "template materialize requires a <name> argument")));
          process.exit(1);
          return;
        }
        let params: TemplateValues = {};
        if (opts.params) {
          try {
            params = JSON.parse(opts.params as string) as TemplateValues;
          } catch {
            console.log(JSON.stringify(fail("BAD_PARAMS", "--params must be a JSON object")));
            process.exit(1);
            return;
          }
          if (params === null || typeof params !== "object" || Array.isArray(params)) {
            console.log(JSON.stringify(fail("BAD_PARAMS", "--params must be a JSON object")));
            process.exit(1);
            return;
          }
        }
        try {
          const res = materializeTemplate(name, params, { cwd: cwd(), home: home(), use: Boolean(opts.use) });
          const payload: Record<string, unknown> = { id: res.id, path: res.path, origin: res.origin };
          if (res.active !== undefined) payload.active = res.active;
          console.log(JSON.stringify(ok(payload)));
        } catch (e) {
          console.log(
            JSON.stringify(
              e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("MATERIALIZE_ERROR", String(e)),
            ),
          );
          process.exit(1);
        }
        return;
      }
      console.log(
        JSON.stringify(
          fail("UNKNOWN_TEMPLATE_SUBCOMMAND", `Unknown template subcommand "${subcommand}"`, {
            available: ["pack", "list", "show", "materialize"],
          }),
        ),
      );
      process.exit(1);
    });
}
