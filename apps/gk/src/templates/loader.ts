import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { GraphKitError } from "../errors.js";
import type { TemplateManifest, Workflow } from "../schemas.js";
import { TemplateManifestSchema, WorkflowSchema } from "../schemas.js";
import { safeResolve } from "../shared/paths.js";

export interface LoadedTemplate {
  /** Absolute directory containing template.yaml/workflow.yaml. */
  directory: string;
  manifest: TemplateManifest;
  workflow: Workflow;
  /** Absolute path to each agent output schema, keyed by node id. */
  outputSchemas: Map<string, string>;
  /** Absolute path to each referenced skill file, keyed by node id. */
  skillFiles: Map<string, string>;
  /** Non-fatal issues collected during load (key mismatch, unsafe path). */
  loaderIssues?: Array<{ code: "SCHEMA_VIOLATION" | "UNSAFE_PATH"; node?: string; message: string; details?: unknown }>;
}

const MANIFEST_FILE = "template.yaml";
const WORKFLOW_FILE = "workflow.yaml";

export async function loadTemplate(directory: string): Promise<LoadedTemplate> {
  const loaderIssues: NonNullable<LoadedTemplate["loaderIssues"]> = [];
  const manifestPath = await safeResolve(directory, MANIFEST_FILE);
  const workflowPath = await safeResolve(directory, WORKFLOW_FILE);

  let manifestRaw: unknown;
  let workflowRaw: unknown;
  try {
    manifestRaw = parse(await readFile(manifestPath, "utf8"), { uniqueKeys: true });
    workflowRaw = parse(await readFile(workflowPath, "utf8"), { uniqueKeys: true });
  } catch (error) {
    if (error instanceof GraphKitError) throw error;
    throw new GraphKitError("SCHEMA_VIOLATION", "invalid YAML", false, error);
  }

  let manifest: TemplateManifest;
  try {
    manifest = TemplateManifestSchema.parse(manifestRaw);
  } catch (error) {
    throw new GraphKitError("SCHEMA_VIOLATION", "invalid template manifest", false, error);
  }

  // Inject node identity from map keys before canonical Zod validation. Where a
  // raw node already declares an `id` that differs from its map key, report a
  // stable SCHEMA_VIOLATION instead of silently replacing it.
  const raw = (workflowRaw && typeof workflowRaw === "object" ? workflowRaw : {}) as Record<string, unknown>;
  const rawNodes = raw.nodes;
  if (rawNodes && typeof rawNodes === "object" && !Array.isArray(rawNodes)) {
    const normalized: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(rawNodes as Record<string, unknown>)) {
      const node =
        value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      if (typeof node.id === "string" && node.id !== id) {
        loaderIssues.push({
          code: "SCHEMA_VIOLATION",
          node: id,
          message: `node id '${node.id}' differs from map key '${id}'`,
        });
      }
      normalized[id] = { ...node, id };
    }
    raw.nodes = normalized;
  }

  let workflow: Workflow;
  try {
    workflow = WorkflowSchema.parse(raw);
  } catch (error) {
    throw new GraphKitError("SCHEMA_VIOLATION", "invalid workflow schema", false, error);
  }

  const outputSchemas = new Map<string, string>();
  const skillFiles = new Map<string, string>();
  for (const [id, node] of Object.entries(workflow.nodes)) {
    if (node.type === "agent") {
      await resolveIfPresent(directory, node.output.schema, outputSchemas, id, loaderIssues);
      await resolveIfPresent(directory, `skills/${node.skill}/SKILL.md`, skillFiles, id, loaderIssues);
    }
  }

  return { directory, manifest, workflow, outputSchemas, skillFiles, loaderIssues };
}

async function resolveIfPresent(
  directory: string,
  relative: string,
  target: Map<string, string>,
  id: string,
  issues: NonNullable<LoadedTemplate["loaderIssues"]>,
): Promise<void> {
  try {
    target.set(id, await safeResolve(directory, relative));
  } catch (error) {
    // Leave unresolved; static validation reports the missing file. Traversal
    // attempts surface as UNSAFE_PATH so they are not silently swallowed.
    if (error instanceof GraphKitError && error.code === "UNSAFE_PATH") {
      issues.push({ code: "UNSAFE_PATH", node: id, message: error.message, details: error.details });
    }
  }
}
