import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Graph } from "../compiler/validate.js";
import { GraphKitError } from "../errors.js";
import { GraphSchema } from "../schemas/graph.schema.js";

const EXT = ".yaml";

const graphsDir = (baseDir: string) => join(baseDir, ".graphkit", "graphs");
const activeFile = (baseDir: string) => join(baseDir, ".graphkit", "active");

function assertInitialized(baseDir: string): void {
  if (!existsSync(join(baseDir, ".graphkit"))) {
    throw new GraphKitError(
      "GRAPHKIT_NOT_INITIALIZED",
      "No .graphkit/ directory — run `gk init` first",
      { baseDir },
    );
  }
}

function ensureGraphsDir(baseDir: string): void {
  assertInitialized(baseDir);
  mkdirSync(graphsDir(baseDir), { recursive: true });
}

/** Local-date stamp `YYYY-MM-DD` (not UTC, so sessions land on the user's day). */
function todayStamp(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Kebab-case, ≤40 chars. Empty input falls back to "graph". */
function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "graph";
}

// Session ids are interpolated into filesystem paths — a pointer file or CLI arg
// carrying "../" must never resolve outside .graphkit/graphs/. Validate against
// the canonical id shape (<date>-<kebab-slug>[<-N>]) before any join.
const SESSION_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,40}(-\d+)?$/;

function assertSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new GraphKitError(
      "INVALID_SESSION_ID",
      `Malformed session graph id "${id}" — expected YYYY-MM-DD-<slug>`,
      { id },
    );
  }
}

export function saveSessionGraph(
  graph: Graph,
  slug: string,
  baseDir: string = process.cwd(),
): { id: string; path: string } {
  ensureGraphsDir(baseDir);
  const base = slugify(slug);
  const dir = graphsDir(baseDir);

  let id = `${todayStamp()}-${base}`;
  for (let suffix = 2; existsSync(join(dir, `${id}${EXT}`)); suffix += 1) {
    id = `${todayStamp()}-${base}-${suffix}`;
  }

  const path = join(dir, `${id}${EXT}`);
  writeFileSync(path, YAML.stringify(graph), "utf-8");
  writeFileSync(activeFile(baseDir), `${id}\n`, "utf-8");
  return { id, path };
}

export function setActiveGraphId(id: string, baseDir: string = process.cwd()): void {
  assertSessionId(id);
  const path = join(graphsDir(baseDir), `${id}${EXT}`);
  if (!existsSync(path)) {
    throw new GraphKitError(
      "GRAPH_NOT_FOUND",
      `No session graph with id "${id}"`,
      { id, available: listSessionGraphs(baseDir).map((g) => g.id) },
    );
  }
  writeFileSync(activeFile(baseDir), `${id}\n`, "utf-8");
}

export function getActiveGraphId(baseDir: string = process.cwd()): string | null {
  assertInitialized(baseDir);
  const file = activeFile(baseDir);
  if (!existsSync(file)) return null;
  const id = readFileSync(file, "utf-8").trim();
  return id === "" ? null : id;
}

export function listSessionGraphs(
  baseDir: string = process.cwd(),
): Array<{ id: string; path: string; name: string; task?: string; createdAt: Date }> {
  assertInitialized(baseDir);
  const dir = graphsDir(baseDir);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((file) => file.endsWith(EXT))
    .map((file) => {
      const id = file.slice(0, -EXT.length);
      const path = join(dir, file);
      const raw = YAML.parse(readFileSync(path, "utf-8")) as {
        metadata?: { name?: unknown; task?: unknown };
      };
      return {
        id,
        path,
        name: typeof raw?.metadata?.name === "string" ? raw.metadata.name : id,
        task: typeof raw?.metadata?.task === "string" ? raw.metadata.task : undefined,
        // mtime is the reliable creation signal; id date prefix is coarse for -2/-3 collisions
        createdAt: statSync(path).mtime,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadActiveGraph(
  baseDir: string = process.cwd(),
): { id: string; graph: Graph; path: string } {
  const id = getActiveGraphId(baseDir);
  if (id === null) {
    throw new GraphKitError(
      "GRAPHKIT_NOT_INITIALIZED",
      "No active graph — run `gk init` first",
      { baseDir },
    );
  }
  assertSessionId(id);
  const path = join(graphsDir(baseDir), `${id}${EXT}`);
  if (!existsSync(path)) {
    throw new GraphKitError(
      "ACTIVE_POINTER_DANGLING",
      `Active pointer "${id}" has no graph file`,
      { id, path, available: listSessionGraphs(baseDir).map((g) => g.id) },
    );
  }

  const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(path, "utf-8")));
  if (!parsed.success) {
    throw new GraphKitError("SCHEMA_INVALID", `Session graph ${id} failed schema validation`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return { id, graph: parsed.data, path };
}