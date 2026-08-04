import { readFile } from "node:fs/promises";
// Local module shim (src/ajv2020.d.ts): ajv's dist/2020.js has no exports-map types.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ErrorCode } from "../errors.js";
import { GraphKitError } from "../errors.js";
import { NodeSchema, type Workflow } from "../schemas.js";
import type { LoadedTemplate } from "../templates/loader.js";
import { conditionReferences } from "./expression.js";

export interface ValidationIssue {
  code: ErrorCode;
  node?: string;
  message: string;
}

/** AJV 2020 with formats; caches compiled schemas by absolute path. */
export const validateOutput = (() => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const cache = new Map<string, ReturnType<Ajv2020["compile"]>>();

  return async function validateOutput(schemaPath: string, value: unknown): Promise<void> {
    let validate = cache.get(schemaPath);
    if (!validate) {
      const schema = JSON.parse(await readFile(schemaPath, "utf8"));
      validate = ajv.compile(schema);
      cache.set(schemaPath, validate);
    }
    if (!validate(value)) {
      throw new GraphKitError("SCHEMA_VIOLATION", "output schema violation", false, validate.errors);
    }
  };
})();

/** Build adjacency maps keyed by node id (outgoing edges; start sentinel included). */
function buildAdjacency(workflow: Workflow): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (from: string, to: string): void => {
    out.set(from, [...(out.get(from) ?? []), to]);
  };
  for (const edge of workflow.edges) {
    const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
    for (const target of targets) add(edge.from, target);
    if (edge.on_error) {
      const fallbacks = Array.isArray(edge.on_error) ? edge.on_error : [edge.on_error];
      for (const target of fallbacks) add(edge.from, target);
    }
  }
  return out;
}

/** Deterministic full traversal from a node: terminal nodes are stops, others fan out. */
function reachable(out: Map<string, string[]>, terminal: Set<string>, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (terminal.has(current)) continue;
    const targets = out.get(current) ?? [];
    for (let i = targets.length - 1; i >= 0; i--) stack.push(targets[i]);
  }
  return seen;
}

/** DFS back-edge detection over the real node graph (start sentinel excluded). */
function cycleNodes(out: Map<string, string[]>, from: string): Set<string> {
  const grey = new Set<string>();
  const black = new Set<string>();
  const inCycle = new Set<string>();
  const onPath: string[] = [];

  const visit = (node: string): void => {
    if (black.has(node) || grey.has(node)) return;
    grey.add(node);
    onPath.push(node);
    const targets = out.get(node) ?? [];
    for (const target of targets) {
      if (black.has(target)) continue;
      if (grey.has(target)) {
        const start = onPath.indexOf(target);
        for (let i = start; i < onPath.length; i++) inCycle.add(onPath[i]);
      } else {
        visit(target);
      }
    }
    onPath.pop();
    grey.delete(node);
    black.add(node);
  };

  visit(from);
  return inCycle;
}

export function validateTemplate(loaded: LoadedTemplate): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wf = loaded.workflow;
  const nodeIds = new Set(Object.keys(wf.nodes));
  const validSources = new Set(["start", ...nodeIds]);
  const out = buildAdjacency(wf);

  const terminal = new Set(wf.terminal.map((t) => t.node));
  const issue = (code: ErrorCode, message: string, node?: string): void => {
    issues.push({ code, message, node });
  };

  // Re-validate node structure: nodes may arrive pre-parsed (skipping zod) in
  // mutated fixtures, so report SCHEMA_VIOLATION per broken node.
  for (const [id, raw] of Object.entries(wf.nodes)) {
    const parsed = NodeSchema.safeParse(raw);
    if (!parsed.success) {
      issue(
        "SCHEMA_VIOLATION",
        `node '${id}' is invalid: ${parsed.error.issues[0]?.message ?? "schema violation"}`,
        id,
      );
    }
  }

  const ALLOWED_GRAPH_OPS = new Set(["complete-task", "branch", "dispatch", "emit"]);
  const ALLOWED_SKILLS = new Set(["worker", "validator", "planner", "reviewer"]);

  for (const [id, node] of Object.entries(wf.nodes)) {
    if (node.type !== "graph" && node.type !== "human") continue;
    if (node.type === "graph") {
      if (!ALLOWED_GRAPH_OPS.has(node.operation)) {
        issue("INVALID_TRANSITION", `unsupported graph operation '${node.operation}'`, id);
      }
      continue;
    }
    // human node: `actions` array (min 1) is enforced by zod.
    if (node.actions.length === 0) {
      issue("INVALID_TRANSITION", "human node requires at least one action", id);
    }
  }

  // Per-node structural and reference checks (agent skills, router routes).
  for (const [id, node] of Object.entries(wf.nodes)) {
    if (node.type === "agent") {
      if (!ALLOWED_SKILLS.has(node.skill)) {
        issue("INVALID_TRANSITION", `unsupported skill '${node.skill}'`, id);
      }
      if (!loaded.outputSchemas.has(id)) {
        issue("SCHEMA_VIOLATION", "agent node requires an output schema", id);
      }
      if (!loaded.skillFiles.has(id)) {
        issue("INVALID_TRANSITION", `skill file 'skills/${node.skill}/SKILL.md' not found`, id);
      }
    }
    if (node.type === "router") {
      for (const route of node.routes) {
        const tos = Array.isArray(route.to) ? route.to : [route.to];
        for (const target of tos) {
          if (!nodeIds.has(target)) issue("INVALID_TRANSITION", `route target '${target}' not found`, id);
        }
        try {
          for (const path of conditionReferences(route.when)) {
            if (path[0] === "nodes" && !nodeIds.has(path[1])) {
              issue("INVALID_TRANSITION", `condition references unknown node '${path[1]}'`, id);
            }
            if (path[0] === "state" && wf.state && !(path[1] in wf.state)) {
              issue("INVALID_TRANSITION", `condition references unknown state field '${path[1]}'`, id);
            }
          }
        } catch (err) {
          issue("ERR_EXPRESSION", err instanceof GraphKitError ? err.message : `invalid condition '${route.when}'`, id);
        }
      }
    }
  }

  // Edges: endpoint existence + condition references.
  wf.edges.forEach((edge, index) => {
    const label = `edges[${index}]`;
    const from = edge.from;
    if (!validSources.has(from)) issue("INVALID_TRANSITION", `edge source '${from}' not found`, label);
    const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
    for (const target of targets) {
      if (!nodeIds.has(target)) issue("INVALID_TRANSITION", `edge target '${target}' not found`, label);
    }
    if (edge.on_error) {
      const fallbacks = Array.isArray(edge.on_error) ? edge.on_error : [edge.on_error];
      for (const target of fallbacks) {
        if (!nodeIds.has(target)) issue("INVALID_TRANSITION", `on_error target '${target}' not found`, label);
      }
    }
    if (edge.when) {
      try {
        for (const path of conditionReferences(edge.when)) {
          if (path[0] === "nodes" && !nodeIds.has(path[1])) {
            issue("INVALID_TRANSITION", `condition references unknown node '${path[1]}'`, label);
          }
          if (path[0] === "state" && wf.state && !(path[1] in wf.state)) {
            issue("INVALID_TRANSITION", `condition references unknown state field '${path[1]}'`, label);
          }
        }
      } catch (err) {
        issue("ERR_EXPRESSION", err instanceof GraphKitError ? err.message : `invalid condition '${edge.when}'`, label);
      }
    }
  });

  // Fanout/join pairing and merge-policy coverage.
  const fanouts = new Map<string, string>(); // from-state -> fanout node
  const joins = new Map<string, string>(); // from-state -> join node
  for (const [id, node] of Object.entries(wf.nodes)) {
    if (node.type === "fanout") fanouts.set(node.from, id);
    if (node.type === "join") joins.set(node.merge, id);
  }
  for (const [stateField, joinNode] of joins) {
    if (!fanouts.has(stateField)) {
      issue("MISSING_MERGE_POLICY", `join '${joinNode}' references state '${stateField}' without a fanout`, joinNode);
      continue;
    }
    if (!wf.state || !(stateField in wf.state)) {
      issue("MISSING_MERGE_POLICY", `join '${joinNode}' references undeclared state '${stateField}'`, joinNode);
    }
  }
  for (const [stateField, fanoutNode] of fanouts) {
    if (!wf.state || !(stateField in wf.state)) {
      issue("INVALID_TRANSITION", `fanout '${fanoutNode}' references undeclared state '${stateField}'`, fanoutNode);
    }
  }
  for (const joinNode of joins.values()) {
    if (!wf.state) {
      issue("MISSING_MERGE_POLICY", `join '${joinNode}' requires a state merge policy`, joinNode);
    }
  }

  // start + reachability. `start` is a virtual sentinel; entry nodes are the real
  // targets of edges from it.
  const entryTargets = out.get(wf.start) ?? [];
  if (entryTargets.length === 0) {
    issue("INVALID_TRANSITION", `start sentinel '${wf.start}' has no outgoing edges`);
  }
  const entries: string[] = entryTargets.length ? entryTargets : [...nodeIds];
  const terminalVerdicts = new Set(wf.terminal.map((t) => t.verdict));
  for (const t of wf.terminal) {
    if (!nodeIds.has(t.node)) {
      issue("INVALID_TRANSITION", `terminal node '${t.node}' not found`, t.node);
      continue;
    }
    if (!entries.some((entry) => reachable(out, terminal, entry).has(t.node))) {
      issue("UNREACHABLE_TERMINAL", `terminal node '${t.node}' is unreachable from start`, t.node);
    }
    if ((out.get(t.node) ?? []).length > 0) {
      issue("INVALID_TRANSITION", `terminal node '${t.node}' has outgoing edges`, t.node);
    }
  }
  if (wf.terminal.length === 0) {
    issue("INVALID_TRANSITION", "workflow has no terminal nodes");
  }
  if (!terminalVerdicts.has("passed")) {
    issue("INVALID_TRANSITION", "no 'passed' terminal verdict declared");
  }
  for (const entry of entries) {
    const cycle = cycleNodes(out, entry);
    for (const node of cycle) {
      issue("UNBOUNDED_CYCLE", `node '${node}' participates in an unbounded cycle`, node);
    }
  }
  for (const [id, node] of Object.entries(wf.nodes)) {
    if (node.type === "fanout" && !node.max_workers) {
      issue("INVALID_TRANSITION", `fanout '${id}' requires max_workers`, id);
    }
  }

  // Sort deterministically: by node (when present), then code.
  issues.sort((a, b) => (a.node ?? "").localeCompare(b.node ?? "") || a.code.localeCompare(b.code));
  return issues;
}
