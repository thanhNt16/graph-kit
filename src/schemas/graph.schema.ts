import { z } from "zod";
import { TIERS } from "../targets/types.js";
import { EvalConfig } from "./eval.schema.js";
import { MemoryConfig } from "./memory.schema.js";
import { TOPOLOGY_NAMES } from "./topology/index.js";

const NodeRef = z.enum(TIERS);

// Constraints are written in YAML as a list of single-key maps:
//   constraints:
//     - max_files: 50
//     - no_write: true
//     - tools_allowlist: "Read, Grep"   # list form also valid: [Read, Grep]
// A constraint may declare provenance via `source`: "human" (operator-declared,
// agents must never modify it) or "author" (default, graph-author declared).
// Any other `source` value surfaces an advisory finding in the compiler.
const ConstraintValue = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));

// Node ids become materialized agent filenames (gk-<id>.md), ledger trace
// anchors, and payload keys — restrict them to filename-safe characters so
// `gk graph agents` can never crash on a mid-write path separator. Enforced
// with a named issue in GraphSchema's superRefine.
export const NODE_ID_RE = /^[A-Za-z0-9._-]+$/;

const RefSchema = z
  .object({
    path: z.string(),
    purpose: z.string(),
  })
  .strict();

const LoopConfig = z
  .object({
    enabled: z.boolean().default(false),
    stop_when: z.string().optional(),
    max_rounds: z.number().int().min(1).default(3),
  })
  .strict();
const AdvisorConfig = z
  .object({
    model: NodeRef.default("fable"),
    after_failed_rounds: z.number().int().min(1).default(1),
    max_calls: z.number().int().min(1).default(1),
  })
  .strict();

// Retries cover transient dispatch failures only (timeout, crash, transport);
// prompt/parse/validation errors are never retried — see gk-execute SKILL.md.
const RetryConfig = z
  .object({
    max_attempts: z.number().int().min(1).default(1),
    initial_interval_ms: z.number().int().min(1).default(1000),
    backoff: z.number().min(1).default(2),
    non_retryable: z.array(z.string()).default([]),
  })
  .strict();

// The orchestrator suspends the run for human approval before dispatching the
// node; approval/rejection happens in conversation, resume via `gk run resume`.
const GateConfig = z
  .object({
    question: z.string().min(1),
    details: z.string().min(1).optional(),
  })
  .strict();

const FanOutConfig = z
  .object({
    briefs_from: z.string().min(1),
    template: z.string().min(1).default("{brief.body}"),
    reduce: z.enum(["append", "merge", "vote"]).default("append"),
  })
  .strict();

export const LoopGroupSchema = z
  .strictObject({
    nodes: z.array(z.string().min(1)).min(1),
    max_rounds: z.number().int().min(1),
    stop_when: z.string().min(1).optional(),
    gate_evidence: z.array(z.string().min(1)).min(1).optional(),
    no_progress_limit: z.number().int().min(2).optional(),
  })
  .refine((data) => Boolean(data.stop_when || data.gate_evidence), {
    message: "At least one of stop_when or gate_evidence must be provided",
  });

export type LoopGroup = z.infer<typeof LoopGroupSchema>;

const NodeDefSchema = z
  .object({
    agent: z.string(),
    model: NodeRef.optional(),
    objective: z.string(),
    tools: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    refs: z.array(RefSchema).default([]),
    depend_on: z.array(z.string()).default([]),
    loop: LoopConfig.optional(),
    constraints: z.array(ConstraintValue).default([]),
    // Challengeable premises the orchestrator may contest (CHALLENGE output
    // contract); materialized into the agent body, never hard requirements.
    assumptions: z.array(z.string()).default([]),
    // Declared write scope as path globs ('src/foo/**'); advisory, surfaced to
    // the agent and to the owns-overlap validation heuristic.
    owns: z.array(z.string()).default([]),
    evidence: z.array(z.string()).default([]),
    // Free-form string; recognized semantic roles: "eval-gate" (evidence gate
    // that requires an `eval` config block and emits a MERGE/BLOCK verdict) and
    // "supervisor" (orchestrator-owned control node). Any other value surfaces
    // an unknown-role advisory warning in the compiler.
    role: z.string().optional(),
    eval: EvalConfig.optional(),
    advisor: AdvisorConfig.optional(),
    fan_out: FanOutConfig.optional(),
    // Natural-language predicate over upstream node results; judged by the
    // orchestrator (same pattern as stop_when). False → node is skipped.
    when: z.string().min(1).optional(),
    // Advisory cap on injected upstream context; the orchestrator compacts
    // oversized inputs and spills the full text to an artifact file.
    budget_tokens: z.number().int().positive().optional(),
    retry: RetryConfig.optional(),
    gate: GateConfig.optional(),
    // Scales fan-out width, budgets, and loop bounds (see gk-execute SKILL.md).
    effort: z.enum(["light", "standard", "deep"]).default("standard"),
    // Per-node dispatch kill budget in ms; forwarded to gk_dispatch_agent's
    // timeout_ms. Unset → the dispatch default (600000). Set explicitly for
    // nodes whose work is known to exceed 10 min (bulk ingestion, builds).
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((n, ctx) => {
    if (n.advisor && !n.loop?.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["advisor"],
        message: "advisor requires loop.enabled: true on the same node",
      });
    }
  });

const EvidenceSchema = z
  .object({
    required_keys: z.array(z.string()),
    format: z.enum(["markdown", "json"]).default("markdown"),
    criteria: z.array(z.string()).optional(),
    freshness: z.enum(["report", "strict"]).default("report"),
    require_landed: z.boolean().default(false),
  })
  .strict();

const HookRef = z
  .object({
    on_node_complete: z.array(z.string()).default([]),
    on_fanout_dispatch: z.array(z.string()).default([]),
    on_graph_complete: z.array(z.string()).default([]),
  })
  .strict();

const OutputSchema = z
  .object({
    evidence_dir: z.string().default(".graphkit/evidence/"),
    report: z.string().default(".graphkit/reports/{name}.md"),
  })
  .strict();

export const GraphSchema = z
  .object({
    apiVersion: z.string().default("graphkit.dev/v2"),
    kind: z.literal("Graph").default("Graph"),
    // Open by design (CHANGELOG): host metadata (project labels, versions)
    // rides along instead of being silently stripped or rejected.
    metadata: z
      .object({
        name: z.string(),
        description: z.string().optional(),
        // Read by the session-graph store (`gk graph list`).
        task: z.string().optional(),
      })
      .passthrough(),
    topology: z.enum(TOPOLOGY_NAMES),
    inputs: z
      .record(
        z.string(),
        // Open like metadata: author-defined extra fields on an input
        // definition pass through rather than being silently stripped.
        z
          .object({
            type: z.enum(["string", "array"]),
            required: z.boolean().default(false),
            default: z.any().optional(),
          })
          .passthrough(),
      )
      .default({}),
    nodes: z.record(z.string(), NodeDefSchema).default({}),
    evidence: EvidenceSchema.optional().default(() => ({
      required_keys: [],
      format: "markdown" as const,
      freshness: "report" as const,
      require_landed: false as const,
    })),
    topology_config: z
      .record(z.string(), z.any())
      .default({})
      .superRefine((cfg, ctx) => {
        // memory config was previously read free-form and silently ignored —
        // validate it here so typos fail at `gk validate`, not at runtime
        if (cfg.memory !== undefined) {
          const r = MemoryConfig.safeParse(cfg.memory);
          if (!r.success) {
            ctx.addIssue({
              code: "custom",
              message: `topology_config.memory: ${r.error.issues[0]?.message ?? "invalid"}`,
            });
          }
        }
      }),
    hooks: HookRef.optional().default(() => ({ on_node_complete: [], on_fanout_dispatch: [], on_graph_complete: [] })),
    outputs: OutputSchema.optional().default(() => ({
      evidence_dir: ".graphkit/evidence/",
      report: ".graphkit/reports/{name}.md",
    })),
    loops: z.array(LoopGroupSchema).optional(),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const nodes = graph.nodes as Record<string, NodeDef>;
    const names = new Set(Object.keys(nodes));
    // Node ids are filenames in waiting (gk-<id>.md agent fragments): reject
    // ids that would break materialization mid-write, naming the offender.
    for (const id of Object.keys(nodes)) {
      // "." / ".." satisfy the charset but traverse when ids become agent
      // filenames (gk-<id>.md) — reject them alongside charset violations.
      if (!NODE_ID_RE.test(id) || id === "." || id === "..") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", id],
          message: `node id "${id}" must match ${NODE_ID_RE.source} and never "." or ".." — ids become agent filenames (gk-<id>.md)`,
        });
      }
    }
    for (const [id, node] of Object.entries(nodes)) {
      for (const dep of node.depend_on) {
        if (!names.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["nodes", id, "depend_on"],
            message: `depend_on references unknown node "${dep}"`,
          });
        }
      }
    }
    // fan_out.briefs_from must be a reachable predecessor (transitive depend_on closure)
    const upstreamOf = (id: string, seen = new Set<string>()): Set<string> => {
      for (const dep of nodes[id]?.depend_on ?? []) {
        if (names.has(dep) && !seen.has(dep)) {
          seen.add(dep);
          for (const t of upstreamOf(dep, seen)) seen.add(t);
        }
      }
      return seen;
    };
    for (const [id, node] of Object.entries(nodes)) {
      if (!node.fan_out) continue;
      const upstream = upstreamOf(id);
      const target = node.fan_out.briefs_from;
      if (!names.has(target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", id, "fan_out", "briefs_from"],
          message: `fan_out.briefs_from references unknown node "${target}"`,
        });
      } else if (!upstream.has(target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", id, "fan_out", "briefs_from"],
          message: `fan_out.briefs_from "${target}" is not an upstream node of "${id}" — add it to depend_on`,
        });
      }
    }
    // Cycle detection: DFS with colors (0=white, 1=gray, 2=black)
    const color = new Map<string, number>();
    const visit = (id: string): boolean => {
      if (color.get(id) === 1) return true;
      if (color.get(id) === 2) return false;
      color.set(id, 1);
      for (const dep of nodes[id]?.depend_on ?? []) {
        if (names.has(dep) && visit(dep)) return true;
      }
      color.set(id, 2);
      return false;
    };
    for (const id of names) {
      if (visit(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", id, "depend_on"],
          message: "depend_on forms a cycle",
        });
        break;
      }
    }
  });

type NodeDef = z.infer<typeof NodeDefSchema>;
export type Graph = z.infer<typeof GraphSchema>;
