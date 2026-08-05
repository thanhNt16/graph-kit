import { readFileSync } from "node:fs";
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
  details?: unknown;
}
const schemaCache = new Map<string, ReturnType<Ajv2020["compile"]>>();

function compileSchema(schemaPath: string): ReturnType<Ajv2020["compile"]> {
  const cached = schemaCache.get(schemaPath);
  if (cached) return cached;
  try {
    // One AJV instance per root schema permits installed/forked templates to
    // retain the same canonical $id without colliding in a global registry.
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
    schemaCache.set(schemaPath, validate);
    return validate;
  } catch (error) {
    throw new GraphKitError("SCHEMA_VIOLATION", "output schema could not be read, parsed, or compiled", false, error);
  }
}

/** Synchronous output-schema boundary, wrapping all failures consistently. */
export function validateOutput(schemaPath: string, value: unknown): void {
  const validate = compileSchema(schemaPath);
  if (!validate(value)) throw new GraphKitError("SCHEMA_VIOLATION", "output schema violation", false, validate.errors);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function buildAdjacency(wf: Workflow): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (from: string, to: string) => out.set(from, [...new Set([...(out.get(from) ?? []), to])]);
  for (const edge of wf.edges) {
    for (const target of Array.isArray(edge.to) ? edge.to : [edge.to]) add(edge.from, target);
    if (edge.on_error)
      for (const target of Array.isArray(edge.on_error) ? edge.on_error : [edge.on_error]) add(edge.from, target);
  }

  // Fanout worker execution is implicit in the template: the runtime dispatches
  // the one agent not targeted by normal edges, then converges on the matching join.
  const normallyTargeted = new Set(wf.edges.flatMap((edge) => (Array.isArray(edge.to) ? edge.to : [edge.to])));
  const implicitWorkers = Object.values(wf.nodes).filter(
    (node) => node.type === "agent" && !normallyTargeted.has(node.id),
  );
  for (const [fanId, fan] of Object.entries(wf.nodes)) {
    if (fan.type !== "fanout" || implicitWorkers.length !== 1) continue;
    const worker = implicitWorkers[0];
    const join = Object.values(wf.nodes).find((node) => node.type === "join" && node.merge === fan.from);
    add(fanId, worker.id);
    if (join) add(worker.id, join.id);
  }
  return out;
}
function reachable(out: Map<string, string[]>, from: string): Set<string> {
  const seen = new Set<string>(),
    stack = [from];
  while (stack.length) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const target of [...(out.get(current) ?? [])].reverse()) stack.push(target);
  }
  return seen;
}
function cycleNodes(out: Map<string, string[]>, from: string): Set<string> {
  const gray = new Set<string>(),
    black = new Set<string>(),
    cycles = new Set<string>(),
    path: string[] = [];
  const visit = (node: string): void => {
    if (black.has(node)) return;
    if (gray.has(node)) {
      const start = path.indexOf(node);
      for (let i = start; i < path.length; i++) cycles.add(path[i]);
      return;
    }
    gray.add(node);
    path.push(node);
    for (const target of out.get(node) ?? []) visit(target);
    path.pop();
    gray.delete(node);
    black.add(node);
  };
  visit(from);
  return cycles;
}

export function validateTemplate(loaded: LoadedTemplate): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wf = loaded.workflow;
  const nodeEntries = Object.entries(wf.nodes);
  const nodeIds = new Set(nodeEntries.map(([id]) => id));
  const out = buildAdjacency(wf);
  const terminals = new Set(wf.terminal.map((t) => t.node));
  const issue = (code: ErrorCode, message: string, node?: string, details?: unknown): void => {
    issues.push({ code, message, node, details });
  };
  for (const item of loaded.loaderIssues ?? []) issue(item.code, item.message, item.node, item.details);
  for (const [node, schemaPath] of [...loaded.outputSchemas.entries()].sort(([a], [b]) => compare(a, b))) {
    try {
      compileSchema(schemaPath);
    } catch (error) {
      issue("SCHEMA_VIOLATION", `output schema for node '${node}' could not be read, parsed, or compiled`, node, error);
    }
  }

  // Validate malformed nodes, then skip all type-specific access for them.
  const validNodes = new Map<string, Workflow["nodes"][string]>();
  for (const [id, raw] of nodeEntries) {
    const parsed = NodeSchema.safeParse(raw);
    if (!parsed.success) {
      for (const zIssue of parsed.error.issues)
        issue("SCHEMA_VIOLATION", `node '${id}': ${zIssue.message}`, id, zIssue);
    } else validNodes.set(id, parsed.data);
  }
  const allowedOps = new Set(["complete-task", "branch", "dispatch", "emit"]);
  const allowedSkills = new Set(["worker", "validator", "planner", "reviewer", "orchestrator"]);
  for (const [id, node] of validNodes) {
    if (node.type === "graph" && !allowedOps.has(node.operation))
      issue("INVALID_TRANSITION", `unsupported graph operation '${node.operation}'`, id);
    if (node.type === "human" && node.actions.length === 0)
      issue("INVALID_TRANSITION", "human node requires at least one action", id);
    if (node.type === "agent") {
      if (!allowedSkills.has(node.skill)) issue("INVALID_TRANSITION", `unsupported skill '${node.skill}'`, id);
      if (!loaded.outputSchemas.has(id)) issue("SCHEMA_VIOLATION", "agent node requires an output schema", id);
      if (!loaded.skillFiles.has(id))
        issue("INVALID_TRANSITION", `skill file 'skills/${node.skill}/SKILL.md' not found`, id);
    }
    if (node.type === "router") {
      for (const route of node.routes) {
        for (const target of Array.isArray(route.to) ? route.to : [route.to])
          if (!nodeIds.has(target)) issue("INVALID_TRANSITION", `route target '${target}' not found`, id);
        try {
          for (const path of conditionReferences(route.when)) {
            if (path[0] === "nodes" && !nodeIds.has(path[1]))
              issue("INVALID_TRANSITION", `condition references unknown node '${path[1]}'`, id);
            if (path[0] === "state" && !(path[1] in (wf.state ?? {})))
              issue("INVALID_TRANSITION", `condition references unknown state field '${path[1]}'`, id);
          }
        } catch (error) {
          issue(
            "ERR_EXPRESSION",
            error instanceof GraphKitError ? error.message : `invalid condition '${route.when}'`,
            id,
          );
        }
      }
    }
  }
  const fanouts = new Map<string, string>(),
    joins = new Map<string, string>();
  for (const [id, node] of validNodes) {
    if (node.type === "fanout") fanouts.set(node.from, id);
    if (node.type === "join") joins.set(node.merge, id);
  }
  for (const [field, joinId] of joins) {
    if (!fanouts.has(field))
      issue("MISSING_MERGE_POLICY", `join '${joinId}' references state '${field}' without a fanout`, joinId);
    else if (!(field in (wf.state ?? {})))
      issue("MISSING_MERGE_POLICY", `join '${joinId}' references undeclared state '${field}'`, joinId);
  }
  for (const [field, fanoutId] of fanouts)
    if (!(field in (wf.state ?? {})))
      issue("INVALID_TRANSITION", `fanout '${fanoutId}' references undeclared state '${field}'`, fanoutId);
  const validSources = new Set([wf.start, ...nodeIds]);
  wf.edges.forEach((edge, index) => {
    const label = `edges[${index}]`;
    if (!validSources.has(edge.from)) issue("INVALID_TRANSITION", `edge source '${edge.from}' not found`, label);
    for (const target of Array.isArray(edge.to) ? edge.to : [edge.to]) {
      if (target === wf.start) issue("INVALID_TRANSITION", `edge target '${wf.start}' is virtual`, label);
      else if (!nodeIds.has(target)) issue("INVALID_TRANSITION", `edge target '${target}' not found`, label);
    }
    if (edge.on_error)
      for (const target of Array.isArray(edge.on_error) ? edge.on_error : [edge.on_error])
        if (target === wf.start || !nodeIds.has(target))
          issue("INVALID_TRANSITION", `on_error target '${target}' not found`, label);
    if (edge.when)
      try {
        for (const path of conditionReferences(edge.when)) {
          if (path[0] === "nodes" && !nodeIds.has(path[1]))
            issue("INVALID_TRANSITION", `condition references unknown node '${path[1]}'`, label);
          if (path[0] === "state" && !(path[1] in (wf.state ?? {})))
            issue("INVALID_TRANSITION", `condition references unknown state field '${path[1]}'`, label);
        }
      } catch (error) {
        issue(
          "ERR_EXPRESSION",
          error instanceof GraphKitError ? error.message : `invalid condition '${edge.when}'`,
          label,
        );
      }
  });

  const entries = out.get(wf.start) ?? [];
  if (!entries.length) issue("INVALID_TRANSITION", `start sentinel '${wf.start}' has no outgoing edges`);
  const seen = reachable(out, wf.start);
  for (const [id] of nodeEntries)
    if (!seen.has(id))
      issue(
        terminals.has(id) ? "UNREACHABLE_TERMINAL" : "INVALID_TRANSITION",
        `node '${id}' is unreachable from start`,
        id,
      );
  for (const terminal of wf.terminal) {
    if (!nodeIds.has(terminal.node))
      issue("INVALID_TRANSITION", `terminal node '${terminal.node}' not found`, terminal.node);
    else if ((out.get(terminal.node) ?? []).length)
      issue("INVALID_TRANSITION", `terminal node '${terminal.node}' has outgoing edges`, terminal.node);
  }
  if (!wf.terminal.length) issue("INVALID_TRANSITION", "workflow has no terminal nodes");
  if (!wf.terminal.some((t) => t.verdict === "passed"))
    issue("INVALID_TRANSITION", "no 'passed' terminal verdict declared");
  if (!wf.limits?.max_iterations || wf.limits.max_iterations <= 0)
    for (const entry of entries)
      for (const id of cycleNodes(out, entry))
        issue("UNBOUNDED_CYCLE", `node '${id}' participates in an unbounded cycle`, id);

  issues.sort((a, b) => compare(a.node ?? "", b.node ?? "") || compare(a.code, b.code));
  return issues;
}
