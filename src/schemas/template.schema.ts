import { z } from "zod";
import { GraphSchema } from "./graph.schema.js";

// Template names are stable CLI identifiers and must not permit path traversal.
export const TEMPLATE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Parameter names are lower camel case or kebab-case.
const PARAM_LOWER_CAMEL_RE = /^[a-z][a-zA-Z0-9]*$/;
const PARAM_KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidParamName(name: string): boolean {
  return PARAM_LOWER_CAMEL_RE.test(name) || PARAM_KEBAB_RE.test(name);
}

const SOLE_PLACEHOLDER_RE = /^\{\{([^{}]+)\}\}$/;
const TOKEN_RE = /\{\{([^{}]+)\}\}/g;

const ParamDefSchema = z.object({
  description: z.string().min(1),
  required: z.boolean().optional().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const CapabilitySchema = z.object({
  purpose: z.string(),
  candidates: z.array(z.string()),
  optional: z.boolean().optional().default(false),
});

const RecommendationsSchema = z.object({
  agents: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  capabilities: z.array(CapabilitySchema).default([]),
});

interface PlaceholderUse {
  param: string;
  embedded: boolean;
  path: string;
}

// Recursively walk a parsed graph value and collect every {{placeholder}} use.
function collectPlaceholders(node: unknown, path: string, out: PlaceholderUse[]): void {
  if (typeof node === "string") {
    const sole = SOLE_PLACEHOLDER_RE.exec(node.trim());
    if (sole) {
      out.push({ param: sole[1], embedded: false, path });
      return;
    }
    TOKEN_RE.lastIndex = 0;
    let match = TOKEN_RE.exec(node);
    while (match !== null) {
      out.push({ param: match[1], embedded: true, path });
      match = TOKEN_RE.exec(node);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const [i, value] of node.entries()) {
      collectPlaceholders(value, `${path}[${i}]`, out);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      collectPlaceholders(value, `${path}.${key}`, out);
    }
  }
}

export const GraphTemplateSchema = z
  .object({
    apiVersion: z.literal("graphkit.dev/v1"),
    kind: z.literal("GraphTemplate"),
    metadata: z.object({
      name: z.string().regex(TEMPLATE_NAME_RE, "Template name must match ^[a-z0-9]+(?:-[a-z0-9]+)*$"),
      description: z.string().min(1),
      version: z.number().int().nonnegative(),
    }),
    parameters: z.record(z.string(), ParamDefSchema).default({}),
    recommendations: RecommendationsSchema.optional().default(() => ({
      agents: [],
      skills: [],
      tools: [],
      capabilities: [],
    })),
    graph: GraphSchema,
  })
  .superRefine((template, ctx) => {
    const params = template.parameters as Record<string, z.infer<typeof ParamDefSchema>>;
    const declared = new Set(Object.keys(params));

    for (const [name, param] of Object.entries(params)) {
      if (!isValidParamName(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", name],
          message: `Parameter name "${name}" must be lower camel case or kebab-case`,
        });
      }
      if (param.required && param.default !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", name],
          message: `Required parameter "${name}" cannot have a default`,
        });
      }
      if (!param.required && param.default === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", name],
          message: `Parameter "${name}" without a default must set required: true`,
        });
      }
    }

    const uses: PlaceholderUse[] = [];
    collectPlaceholders(template.graph, "graph", uses);
    const referenced = new Set<string>();

    for (const use of uses) {
      // Trailing `.json` selects the raw value (JSON round-trip form) instead
      // of the string form; validate against the base parameter name.
      const jsonForm = use.param.endsWith(".json");
      const base = jsonForm ? use.param.slice(0, -5) : use.param;
      referenced.add(base);
      if (!isValidParamName(base)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [use.path],
          message: `Malformed placeholder "{{${use.param}}}"`,
        });
      }
      if (!declared.has(base)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [use.path],
          message: `Placeholder "{{${use.param}}}" references undeclared parameter`,
        });
      }
      const def = params[base]?.default;
      if (use.embedded && def !== undefined && typeof def !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [use.path],
          message: `Placeholder "{{${use.param}}}" is embedded in text but its default is not a string`,
        });
      }
    }

    for (const name of declared) {
      if (!referenced.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", name],
          message: `Declared parameter "${name}" is unused`,
        });
      }
    }
  });

export type GraphTemplate = z.infer<typeof GraphTemplateSchema>;
export type TemplateValues = Record<
  string,
  string | number | boolean | Array<unknown> | Record<string, unknown>
>;

function resolveValue(key: string, template: GraphTemplate, values: TemplateValues): unknown {
  const jsonForm = key.endsWith(".json");
  const base = jsonForm ? key.slice(0, -5) : key;
  let value: unknown = base in values ? values[base] : template.parameters[base]?.default;
  if (value === undefined) {
    throw new Error(`Missing value for required parameter "${base}"`);
  }
  if (jsonForm && typeof value === "string") {
    value = JSON.parse(value);
  }
  return value;
}

function substituteString(value: string, template: GraphTemplate, values: TemplateValues): unknown {
  const sole = SOLE_PLACEHOLDER_RE.exec(value.trim());
  if (sole) return resolveValue(sole[1], template, values);
  TOKEN_RE.lastIndex = 0;
  return value.replace(TOKEN_RE, (_match, key: string) => {
    const resolved = resolveValue(key, template, values);
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  });
}

function substitute(node: unknown, template: GraphTemplate, values: TemplateValues): unknown {
  if (typeof node === "string") return substituteString(node, template, values);
  if (Array.isArray(node)) return node.map((value) => substitute(value, template, values));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = substitute(value, template, values);
    }
    return out;
  }
  return node;
}

/**
 * Substitute parameter values into a validated template and produce an ordinary
 * Graph v2 document. The result is re-validated against GraphSchema so callers
 * receive exactly what the rest of the toolchain expects.
 */
export function materializeTemplate(template: GraphTemplate, values: TemplateValues): z.infer<typeof GraphSchema> {
  const graph = substitute(template.graph, template, values) as unknown as z.infer<typeof GraphSchema>;
  return GraphSchema.parse(graph);
}
