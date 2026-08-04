import { readFile } from "node:fs/promises";
import { parse } from "yaml";
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
}

const MANIFEST_FILE = "template.yaml";
const WORKFLOW_FILE = "workflow.yaml";

export async function loadTemplate(directory: string): Promise<LoadedTemplate> {
  const manifestPath = await safeResolve(directory, MANIFEST_FILE);
  const workflowPath = await safeResolve(directory, WORKFLOW_FILE);

  const manifestRaw = parse(await readFile(manifestPath, "utf8"));
  const workflowRaw = parse(await readFile(workflowPath, "utf8"));

  const manifest = TemplateManifestSchema.parse(manifestRaw);

  // Inject node identity from map keys before canonical Zod validation.
  const rawNodes = (workflowRaw as Record<string, unknown>).nodes;
  if (rawNodes && typeof rawNodes === "object" && !Array.isArray(rawNodes)) {
    const normalizedNodes: Record<string, unknown> = {};
    for (const [id, rawNode] of Object.entries(rawNodes as Record<string, unknown>)) {
      normalizedNodes[id] = { ...(rawNode as Record<string, unknown>), id };
    }
    (workflowRaw as Record<string, unknown>).nodes = normalizedNodes;
  }
  const workflow = WorkflowSchema.parse(workflowRaw);

  const nodes: Workflow["nodes"] = {};
  for (const [id, rawNode] of Object.entries(workflow.nodes)) {
    nodes[id] = { ...rawNode, id };
  }

  const outputSchemas = new Map<string, string>();
  const skillFiles = new Map<string, string>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type === "agent") {
      await resolveIfPresent(directory, node.output.schema, outputSchemas, id);
      await resolveIfPresent(directory, `skills/${node.skill}/SKILL.md`, skillFiles, id);
    }
  }

  return { directory, manifest, workflow: { ...workflow, nodes }, outputSchemas, skillFiles };
}

async function resolveIfPresent(
  directory: string,
  relative: string,
  target: Map<string, string>,
  id: string,
): Promise<void> {
  try {
    target.set(id, await safeResolve(directory, relative));
  } catch {
    // Leave unresolved; static validation reports the missing file.
  }
}
