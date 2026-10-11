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
  // `type` is authorial documentation ("string" | "number" | ...) carried
  // verbatim into template payloads; substitution uses TemplateValues, so it
  // does not constrain anything. `description` is recommended but not required.
  type: z.string().optional(),
  description: z.string().min(1).optional(),
  required: z.boolean().optional(),
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

// Placeholders may sit in non-string positions (e.g. loops[].max_rounds).
// Substitute only the placeholders that actually fail GraphSchema in a
// non-string position — replacing them with the parameter's declared default
// — and leave every other placeholder intact so materialize can still
// override it. A placeholder in a bad position without a default stays put
// and fails validation as an authoring error.
function solePlaceholderAt(node: unknown, path: PropertyKey[]): string | null {
  let cur: unknown = node;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  if (typeof cur !== "string") return null;
  const m = SOLE_PLACEHOLDER_RE.exec(cur.trim());
  return m ? m[1] : null;
}

function setAtPath(node: unknown, path: PropertyKey[], value: unknown): void {
  let cur = node as Record<PropertyKey, unknown>;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] as Record<PropertyKey, unknown>;
  cur[path[path.length - 1]] = value;
}

interface PlaceholderPatch {
  path: (string | number)[];
  placeholder: string;
}

function applyParamDefaults(doc: unknown): unknown {
  if (!doc || typeof doc !== "object") return doc;
  const raw = doc as Record<string, unknown>;
  if (!raw.graph || typeof raw.graph !== "object") return doc;
  const params = (raw.parameters ?? {}) as Record<string, { default?: unknown }>;
  const probe = GraphSchema.safeParse(raw.graph);
  if (probe.success) return doc;
  const graph = structuredClone(raw.graph);
  const patches: PlaceholderPatch[] = [];
  for (const issue of probe.error.issues) {
    const placeholder = solePlaceholderAt(raw.graph, issue.path);
    if (!placeholder) continue;
    const def = params[placeholder]?.default;
    if (def === undefined) continue;
    setAtPath(graph, issue.path, def);
    patches.push({ path: issue.path.filter((k): k is string | number => typeof k !== "symbol"), placeholder });
  }
  if (patches.length === 0) return doc;
  // The patch list rides into the parsed output so the final transform can
  // restore the placeholders — a template must keep them live for
  // materialize-time overrides even though GraphSchema only sees defaults.
  return { ...raw, graph, __placeholderPatches: patches };
}

export const GraphTemplateSchema = z
  .preprocess(
    applyParamDefaults,
    z.object({
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
      // Internal: patch locations where applyParamDefaults swapped a
      // placeholder for its default so the embedded graph could validate.
      __placeholderPatches: z
        .array(
          z.object({
            path: z.array(z.union([z.string(), z.number()])),
            placeholder: z.string(),
          }),
        )
        .optional(),
    }),
  )
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

    // applyParamDefaults already substituted every defaulted placeholder,
    // so a param referenced only in non-string positions (e.g. a numeric
    // max_rounds) leaves no placeholder to count above — treat its default
    // value appearing in the parsed graph as the reference instead.
    const containsValue = (node: unknown, target: unknown): boolean => {
      // String defaults substitute into text, so they survive as substrings;
      // scalar defaults (numbers, booleans) land as exact values.
      if (typeof node === "string" && typeof target === "string") return node.includes(target);
      if (node === target) return true;
      if (Array.isArray(node)) return node.some((v) => containsValue(v, target));
      if (node && typeof node === "object" && typeof target !== "object") {
        return Object.values(node as Record<string, unknown>).some((v) => containsValue(v, target));
      }
      return false;
    };

    for (const name of declared) {
      const def = params[name]?.default;
      const consumed = def !== undefined && containsValue(template.graph, def);
      if (!referenced.has(name) && !consumed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", name],
          message: `Declared parameter "${name}" is unused`,
        });
      }
    }
  })
  .transform((template) => {
    // Restore placeholders into the parsed graph so materialize-time values
    // still reach them (GraphSchema only ever saw the declared defaults).
    const { __placeholderPatches, ...rest } = template;
    for (const patch of __placeholderPatches ?? []) {
      setAtPath(rest.graph, patch.path, `{{${patch.placeholder}}}`);
    }
    return rest;
  });

export type GraphTemplate = z.infer<typeof GraphTemplateSchema>;
export type TemplateValues = Record<string, string | number | boolean | Array<unknown> | Record<string, unknown>>;

function resolveValue(key: string, template: GraphTemplate, values: TemplateValues): unknown {
  const jsonForm = key.endsWith(".json");
  const base = jsonForm ? key.slice(0, -5) : key;
  let value: unknown = base in values ? values[base] : template.parameters[base]?.default;
  if (value === undefined) {
    // Audit F7: an optional parameter may omit its default — an unprovided
    // optional resolves to an empty string instead of forcing `default: ""`
    // sentinels into template sources.
    if (template.parameters[base] && !template.parameters[base].required) return "";
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
  // Audit F5: a value the user already supplied at materialize must not be
  // re-demanded by `gk run start` — write each provided param through to the
  // matching declared input's default. Same-name collision (template
  // parameter vs embedded input): the materialized value wins; `--input`
  // still overrides at run. Params without a declared input are skipped —
  // nothing demands them, and synthesizing an input entry would mean
  // inventing its `type`.
  for (const [name, value] of Object.entries(values)) {
    if (graph.inputs && name in graph.inputs) graph.inputs[name].default = value;
  }
  return GraphSchema.parse(graph);
}
