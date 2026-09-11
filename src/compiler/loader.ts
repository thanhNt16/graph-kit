import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { GraphKitError } from "../errors.js";
import { GraphSchema } from "../schemas/graph.schema.js";
import { getActiveGraphId, loadActiveGraph } from "../store/index.js";
import type { Graph } from "./validate.js";

// Shared graph.yaml loader — the single schema-validating entry point used by
// the CLI (graph validate/compile/svg/ascii/waves, gate, doctor, status,
// evidence). Lives in src/compiler so it sits next to the schema it enforces.

export function loadGraph(file: string) {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GraphKitError("GRAPH_FILE_NOT_FOUND", `file not found: ${file}`, {
        file,
        hint: "run `gk graph new <topology>` to scaffold one, or check the path",
      });
    }
    throw e;
  }
  // Wrap the raw YAML parse error: a first-run typo used to surface as a
  // generic VALIDATE_ERROR whose message happened to contain "line N, column
  // M" — with the filename nowhere in it. YAML_INVALID carries file + line +
  // column so both the JSON envelope and the human findings list can point at
  // the exact spot.
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (e) {
    if (e instanceof GraphKitError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const pos = msg.match(/at line (\d+), column (\d+)/);
    const [, line, column] = pos ?? [];
    throw new GraphKitError(
      "YAML_INVALID",
      `${file} is not valid YAML${pos ? ` (${file}:${line}:${column})` : ""}: ${msg}`,
      {
        file,
        ...(line ? { line: Number(line), column: Number(column) } : {}),
        hint: "Fix the YAML syntax at the listed position — common causes: unquoted colons in values, bad indentation, unclosed flow sequences",
      },
    );
  }
  const parsed = GraphSchema.safeParse(doc);
  if (!parsed.success) {
    throw new GraphKitError("SCHEMA_INVALID", "graph.yaml failed schema validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

// Spec §3.3 — validate-only wiring: bare `gk validate` reads the active session
// graph when the project is initialized with an active pointer, falling back to
// root ./graph.yaml otherwise. compile/gate/ascii/waves stay explicit-path.
export function resolveBareValidateGraph(): Graph {
  const baseDir = process.cwd();
  if (!existsSync(join(baseDir, ".graphkit"))) return loadGraph(join(baseDir, "graph.yaml"));
  const active = getActiveGraphId();
  if (active !== null) return loadActiveGraph().graph; // dangling → ACTIVE_POINTER_DANGLING with available ids
  if (existsSync(join(baseDir, "graph.yaml"))) return loadGraph(join(baseDir, "graph.yaml"));
  throw new GraphKitError(
    "NO_ACTIVE_GRAPH",
    "No active graph and no graph.yaml — run `gk template materialize --use` or `gk init` first",
    { baseDir },
  );
}
