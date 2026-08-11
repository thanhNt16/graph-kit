import { existsSync } from "node:fs";
import { join } from "node:path";
import { GraphKitError } from "../errors.js";
import { TOPOLOGY_NAMES } from "../schemas/topology/index.js";

const MAX_DEPTH = 3;

export function resolveTopologyConfig(
  _topology: string,
  topologyConfig: Record<string, unknown>,
  templatesDir: string,
  depth = 0,
): Record<string, unknown> {
  if (depth > MAX_DEPTH) {
    throw new GraphKitError("SUBGRAPH_TOO_DEEP", `Subgraph nesting exceeds ${MAX_DEPTH} levels`);
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(topologyConfig)) {
    if (value && typeof value === "object" && !Array.isArray(value) && "template" in value) {
      const sub = value as Record<string, unknown> & { template: string };
      if (!TOPOLOGY_NAMES.includes(sub.template as never)) {
        throw new GraphKitError("UNKNOWN_SUBGRAPH", `Subgraph template "${sub.template}" is not a canonical topology`);
      }
      if (!existsSync(join(templatesDir, `${sub.template}.workflow.js`))) {
        throw new GraphKitError(
          "SUBGRAPH_TEMPLATE_MISSING",
          `Template file for "${sub.template}" not found in ${templatesDir}`,
        );
      }
      // Recurse: subgraphs may themselves contain subgraph refs
      resolved[key] = {
        ...resolveTopologyConfig(sub.template, sub, templatesDir, depth + 1),
        __subgraph: sub.template, // marker the emitter uses to inline the sub-template
      };
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}
