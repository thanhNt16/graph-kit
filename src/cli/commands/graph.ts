import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { CBM_UNAVAILABLE_MSG, type CbmClient } from "../../cbm/client.js";
import type { QueryResult, SearchResult, TraceResult } from "../../cbm/contract.js";
import { routeAndRetrieve } from "../../cbm/route.js";
import { compileGraph } from "../../compiler/emitter.js";
import { planGraph } from "../../compiler/plan.js";
import { isBlocking, validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import type { Graph } from "../../schemas/graph.schema.js";
import { GraphSchema } from "../../schemas/graph.schema.js";
import { GraphTemplateSchema } from "../../schemas/template.schema.js";
import { getTopologyConfigKeys, TOPOLOGY_NAMES, type TopologyName } from "../../schemas/topology/index.js";
import { getActiveGraphId, listSessionGraphs, loadActiveGraph, setActiveGraphId } from "../../store/index.js";
import { renderAscii } from "../ascii.js";
import { seamClientFactory, seamIndexProject } from "../cbm-seam.js";
import { leafUsageFor, subcommandsFor } from "../command-registry.js";
import { formatZodIssues } from "../diagnostics.js";
import { resolveGraph, resolveGraphPath } from "../graph-resolve.js";
import { materializeNodeAgents } from "../node-agents.js";
import { emit, fail, ok, type Result } from "../output.js";
import { renderSvg } from "../svg.js";
import { templatesDir } from "./kit.js";

// Own the create→call→close lifecycle so a thrown call can't leak the spawned
// CBM child process (mirrors memory.ts indexMemory's try/finally).
async function cbmCall<T>(fn: (client: CbmClient) => Promise<T>): Promise<T> {
  const client = seamClientFactory()();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// Prepend the F3 contract when the rejection isn't already carrying it, so gk
// always exits with the honest CBM_CMD/CBM_ARGS guidance — never a bare errno.
function cbmFailure(e: unknown): ReturnType<typeof fail> {
  const msg = String((e as Error)?.message ?? e);
  return fail(
    "CBM_UNAVAILABLE",
    msg.includes("@graphkit/codebase-memory-mcp") ? msg : `${CBM_UNAVAILABLE_MSG}\n${msg}`,
  );
}

// Read + YAML-parse a graph document, wrapping ENOENT in the canonical
// GRAPH_FILE_NOT_FOUND envelope. Shared by loadGraph and the template-routing
// pre-check in `gk validate` so both report missing files identically.
function readGraphDoc(file: string): unknown {
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
  return YAML.parse(raw);
}

export function loadGraph(file: string) {
  const doc = readGraphDoc(file);
  const parsed = GraphSchema.safeParse(doc);
  if (!parsed.success) {
    throw new GraphKitError("SCHEMA_INVALID", "graph.yaml failed schema validation", {
      issues: formatZodIssues(parsed.error, GraphSchema),
    });
  }
  return parsed.data;
}

// A `kind: GraphTemplate` wrapper is not a graph — running it through
// GraphSchema surfaced a 4-issue noise wall (audit F3). Detect the kind field
// before the Graph parse and validate against GraphTemplateSchema instead;
// the template's inner graph is placeholder-substituted and re-validated
// against GraphSchema at materialize time.
function validateTemplateDoc(doc: unknown): Result {
  const parsed = GraphTemplateSchema.safeParse(doc);
  if (!parsed.success) {
    return fail("SCHEMA_INVALID", "graph template failed schema validation", {
      issues: formatZodIssues(parsed.error, GraphTemplateSchema),
    });
  }
  return ok({
    valid: true,
    kind: "template",
    name: parsed.data.metadata.name,
    parameters: parsed.data.parameters,
  });
}

// Valid graph.yaml templates for each topology — emitted by `gk graph new <topology>`
export function graphTemplate(topology: TopologyName): string {
  const name = topology.replace(/[^a-z0-9]+/g, "-");
  const templates: Record<TopologyName, string> = {
    diamond: `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: ${name}
  description: Diamond — fan-out workers, reduce, synthesize
topology: diamond
inputs:
  task:
    type: string
    required: true
nodes:
  scouter:
    agent: software-architect
    model: opus
    objective: |
      Analyze the task. Break it into independent work items.
      Produce a list of items for parallel workers.
    tools: [Read, Glob, Grep]
    depend_on: []
    evidence: [work_items]
  worker:
    agent: code-reviewer
    model: sonnet
    objective: |
      Complete the assigned work item.
      Record findings, changes, and evidence.
    depend_on: [scouter]
    evidence: [findings]
  synthesizer:
    agent: software-architect
    model: opus
    objective: |
      Merge all worker findings into a single report.
      Resolve conflicts, prioritize recommendations.
    depend_on: [worker]
    evidence: [report]
evidence:
  required_keys: [report]
  format: markdown
`,
    "classify-and-act": `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: ${name}
  description: Classify-and-act — route input to one handler
topology: classify-and-act
inputs:
  task:
    type: string
    required: true
nodes:
  classifier:
    agent: software-architect
    model: sonnet
    objective: |
      Classify the input into exactly one category.
      Return ONLY the category label.
    depend_on: []
    evidence: [label]
  handler-a:
    agent: code-reviewer
    model: sonnet
    objective: Handle category A.
    depend_on: [classifier]
    evidence: [result]
  handler-b:
    agent: qa-engineer
    model: sonnet
    objective: Handle category B.
    depend_on: [classifier]
    evidence: [result]
  fallback:
    agent: document-generator
    model: haiku
    objective: Handle unknown categories gracefully.
    depend_on: [classifier]
    evidence: [result]
topology_config:
  classifier: classifier
  routes:
    - condition: category-a
      handler: handler-a
    - condition: category-b
      handler: handler-b
  fallback: fallback
evidence:
  required_keys: [result]
`,
    "adversarial-verification": `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: ${name}
  description: Adversarial verification — produce, refute, adjudicate
topology: adversarial-verification
inputs:
  task:
    type: string
    required: true
nodes:
  producer:
    agent: code-reviewer
    model: sonnet
    objective: Produce findings or claims to be verified.
    depend_on: []
    evidence: [claims]
  refuter-1:
    agent: qa-engineer
    model: sonnet
    objective: Try to REFUTE each claim. Default to refuted if uncertain.
    depend_on: [producer]
    evidence: [verdicts]
  refuter-2:
    agent: agents-orchestrator
    model: sonnet
    objective: Try to REFUTE each claim from a different angle.
    depend_on: [producer]
    evidence: [verdicts]
  adjudicator:
    agent: software-architect
    model: opus
    objective: Count survivals. Claims surviving >= threshold are kept.
    depend_on: [refuter-1, refuter-2]
    evidence: [verified_claims]
topology_config:
  producer: producer
  refuters: [refuter-1, refuter-2]
  survive_threshold: 2
  adjudicator: adjudicator
evidence:
  required_keys: [verified_claims]
`,
    "loop-until-done": `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: ${name}
  description: Loop until done — discover, work, dedup until dry
topology: loop-until-done
inputs:
  task:
    type: string
    required: true
nodes:
  scouter:
    agent: software-architect
    model: opus
    objective: |
      Discover NEW work items not yet found.
      Return empty if nothing new.
    depend_on: []
    evidence: [discovered_items]
  worker:
    agent: code-reviewer
    model: sonnet
    objective: Process the assigned work item.
    depend_on: [scouter]
    evidence: [results]
topology_config:
  scouter: scouter
  worker_batch: worker
  stop_rule: dry_rounds
  dry_threshold: 2
evidence:
  required_keys: [results]
`,
    "generate-and-filter": `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: ${name}
  description: Generate-and-filter — many candidates, keep best K
topology: generate-and-filter
inputs:
  task:
    type: string
    required: true
nodes:
  generator-1:
    agent: software-architect
    model: sonnet
    objective: Generate candidates from angle 1.
    depend_on: []
    evidence: [candidates]
  generator-2:
    agent: code-reviewer
    model: sonnet
    objective: Generate candidates from angle 2.
    depend_on: []
    evidence: [candidates]
  generator-3:
    agent: ui-ux-researcher
    model: sonnet
    objective: Generate candidates from angle 3.
    depend_on: []
    evidence: [candidates]
  scorer:
    agent: qa-engineer
    model: opus
    objective: Score each candidate against the rubric. Return ranked.
    depend_on: [generator-1, generator-2, generator-3]
    evidence: [ranked]
topology_config:
  generators: [generator-1, generator-2, generator-3]
  rubric: |
    Correctness, completeness, feasibility.
    Score 1-10. Higher is better.
  keep_top: 3
  scorer: scorer
evidence:
  required_keys: [ranked]
`,
    tournament: `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: ${name}
  description: Tournament — pairwise elimination to one champion
topology: tournament
inputs:
  task:
    type: string
    required: true
nodes:
  candidate-1:
    agent: software-architect
    model: sonnet
    objective: Produce a candidate solution emphasizing aspect 1.
    depend_on: []
    evidence: [solution]
  candidate-2:
    agent: code-reviewer
    model: sonnet
    objective: Produce a candidate solution emphasizing aspect 2.
    depend_on: []
    evidence: [solution]
  candidate-3:
    agent: data-engineer
    model: sonnet
    objective: Produce a candidate solution emphasizing aspect 3.
    depend_on: []
    evidence: [solution]
  candidate-4:
    agent: ui-ux-researcher
    model: sonnet
    objective: Produce a candidate solution emphasizing aspect 4.
    depend_on: []
    evidence: [solution]
  judge:
    agent: software-architect
    model: opus
    objective: |
      Compare two candidates. Pick the better one.
      Return {winner: "A"|"B", reason: "..."}.
    depend_on: [candidate-1, candidate-2, candidate-3, candidate-4]
    evidence: [champion]
topology_config:
  candidates: [candidate-1, candidate-2, candidate-3, candidate-4]
  judge: judge
evidence:
  required_keys: [champion]
`,
    "memory-augmented": `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: ${name}
  description: Memory-augmented — wraps an inner topology with a Curator
topology: memory-augmented
inputs:
  task:
    type: string
    required: true
topology_config:
  inner:
    template: diamond
  memory:
    project: graph-kit-memory
    cadence: on_node_complete
    curator_node: curator
    recall_topk: 5
    expire_policy: act_r
    null_intervention_allowed: true
nodes:
  scouter:
    agent: software-architect
    model: opus
    objective: Analyze the task and break it into work items.
    depend_on: []
    evidence: [work_items]
  worker:
    agent: code-reviewer
    model: sonnet
    objective: Complete the assigned work item.
    depend_on: [scouter]
    evidence: [findings]
  synthesizer:
    agent: software-architect
    model: opus
    objective: Merge findings into a report.
    depend_on: [worker]
    evidence: [report]
  curator:
    agent: memory-curator
    model: opus
    objective: |
      Curate memory: extract, consolidate, resolve, expire.
      Decide whether to inject a reminder or stay silent.
    depend_on: []
    evidence: [memory_delta, injection_decision]
evidence:
  required_keys: [report]
`,
    custom: `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: ${name}
  description: Custom DAG — define any acyclic graph via depend_on
topology: custom
nodes:
  step-1:
    agent: code-reviewer
    objective: "First step — no dependencies"
    depend_on: []
  step-2:
    agent: code-reviewer
    objective: "Second step — depends on step-1"
    depend_on: [step-1]
`,
    sdd: `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: sdd
  description: Subagent-driven development — brainstorm, plan, parallel workers, review, test loop
topology: custom
inputs:
  task: { type: string, required: true }
nodes:
  brainstormer:
    agent: software-architect
    model: opus
    objective: |
      Brainstorm the approach. Ask clarifying questions.
      Identify key decisions and constraints.
    depend_on: []
    evidence: [approach, decisions]
  planner:
    agent: software-architect
    model: opus
    objective: |
      Write a detailed implementation plan with tasks.
      Each task should be independently assignable.
    depend_on: [brainstormer]
    evidence: [plan, task_list]
  worker-1:
    agent: code-reviewer
    model: sonnet
    objective: Execute plan task 1. Write tests. Record evidence.
    depend_on: [planner]
    evidence: [implementation, tests]
  worker-2:
    agent: code-reviewer
    model: sonnet
    objective: Execute plan task 2. Write tests. Record evidence.
    depend_on: [planner]
    evidence: [implementation, tests]
  worker-3:
    agent: data-engineer
    model: sonnet
    objective: Execute plan task 3. Write tests. Record evidence.
    depend_on: [planner]
    evidence: [implementation, tests]
  reviewer:
    agent: agents-orchestrator
    model: sonnet
    objective: |
      Review all worker implementations against the plan.
      Check for integration issues, missing tests, code quality.
    depend_on: [worker-1, worker-2, worker-3]
    evidence: [review_findings]
  tester:
    agent: qa-engineer
    model: haiku
    objective: |
      Run all tests. Report failures with details.
      Return {passed: bool, failures: [...]}.
    depend_on: [reviewer]
    loop:
      enabled: true
      stop_when: all tests pass
      max_rounds: 5
    evidence: [test_results, coverage]
evidence:
  required_keys: [test_results]
`,
    superpowers: `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: superpowers
  description: Superpowers flow — brainstorm, plan, parallel execution, test until done
topology: custom
inputs:
  task: { type: string, required: true }
nodes:
  brainstormer:
    agent: software-architect
    model: opus
    objective: Brainstorm and clarify the task. Explore approaches.
    depend_on: []
    evidence: [approach]
  planner:
    agent: software-architect
    model: opus
    objective: |
      Write a bite-sized implementation plan.
      Split into independent, testable tasks.
    depend_on: [brainstormer]
    evidence: [plan]
  executor-1:
    agent: code-reviewer
    model: sonnet
    objective: Implement task 1 from the plan. TDD — write test first.
    depend_on: [planner]
    evidence: [code, tests]
  executor-2:
    agent: code-reviewer
    model: sonnet
    objective: Implement task 2 from the plan. TDD — write test first.
    depend_on: [planner]
    evidence: [code, tests]
  executor-3:
    agent: ui-ux-researcher
    model: sonnet
    objective: Implement task 3 from the plan. TDD — write test first.
    depend_on: [planner]
    evidence: [code, tests]
  tester:
    agent: qa-engineer
    model: haiku
    objective: |
      Run all tests. If any fail, report which and why.
      Return {passed, failures} so the loop can decide.
    depend_on: [executor-1, executor-2, executor-3]
    loop:
      enabled: true
      stop_when: all tests pass
      max_rounds: 5
    evidence: [test_results]
evidence:
  required_keys: [test_results]
`,
    "research-and-build": `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: research-and-build
  description: Research tools/approaches, then plan and build based on findings
topology: custom
inputs:
  task: { type: string, required: true }
nodes:
  scouter:
    agent: software-architect
    model: opus
    objective: |
      Identify what needs researching.
      Break the research into independent areas.
    depend_on: []
    evidence: [research_areas]
  researcher-1:
    agent: data-engineer
    model: sonnet
    objective: Deep-dive research area 1. Report findings, pros/cons, evidence.
    depend_on: [scouter]
    evidence: [findings]
  researcher-2:
    agent: code-reviewer
    model: sonnet
    objective: Deep-dive research area 2. Report findings, pros/cons, evidence.
    depend_on: [scouter]
    evidence: [findings]
  researcher-3:
    agent: ui-ux-researcher
    model: sonnet
    objective: Deep-dive research area 3. Report findings, pros/cons, evidence.
    depend_on: [scouter]
    evidence: [findings]
  planner:
    agent: software-architect
    model: opus
    objective: |
      Synthesize research into a build plan.
      Decide what to build vs leverage.
    depend_on: [researcher-1, researcher-2, researcher-3]
    evidence: [decision, plan]
  builder-1:
    agent: code-reviewer
    model: sonnet
    objective: Build plan task 1. Write code and tests.
    depend_on: [planner]
    evidence: [implementation]
  builder-2:
    agent: data-engineer
    model: sonnet
    objective: Build plan task 2. Write code and tests.
    depend_on: [planner]
    evidence: [implementation]
  reviewer:
    agent: agents-orchestrator
    model: opus
    objective: Review the full build against the plan. Verify integration.
    depend_on: [builder-1, builder-2]
    evidence: [review, verdict]
evidence:
  required_keys: [verdict]
`,
  };
  return templates[topology];
}

export function registerGraphCommands(cli: CAC) {
  cli
    .command("validate [file]", "Validate a graph.yaml")
    .option("--json", "JSON output")
    .action((file) => {
      try {
        // Template wrapper pre-check (audit F3): only explicit file args can be
        // templates — the bare path resolves the active session graph, which is
        // always a materialized Graph.
        if (file) {
          const doc = readGraphDoc(String(file));
          if (typeof doc === "object" && doc !== null && "kind" in doc && doc.kind === "GraphTemplate") {
            emit(validateTemplateDoc(doc));
            return;
          }
        }
        const graph = resolveGraph(process.cwd(), file);
        const findings = validateGraph(graph, process.cwd());
        if (findings.some(isBlocking)) {
          emit(fail("VALIDATION_FAILED", "graph has findings", { issues: findings }));
          return;
        }
        emit(ok({ valid: true, topology: graph.topology, warnings: findings.filter((f) => !isBlocking(f)) }));
      } catch (e) {
        emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("VALIDATE_ERROR", String(e)));
      }
    });

  cli
    .command("compile [file]", "Compile graph.yaml to a .workflow.js script")
    .option("--output <path>", "Output path (default .claude/workflows/{name}.workflow.js)")
    .option("--json", "JSON output")
    .action((file, opts) => {
      try {
        const graph = resolveGraph(process.cwd(), file);
        const findings = validateGraph(graph, process.cwd());
        if (findings.some(isBlocking)) {
          emit(fail("VALIDATION_FAILED", "fix findings before compile", { issues: findings }));
          return;
        }
        const script = compileGraph(graph, templatesDir());
        const outPath =
          opts.output ?? join(process.cwd(), ".claude", "workflows", `${graph.metadata.name}.workflow.js`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, script);
        emit(ok({ compiled: outPath, topology: graph.topology }));
      } catch (e) {
        emit(fail("COMPILE_ERROR", String(e)));
      }
    });

  cli
    .command("graph [subcommand] [args...]", `Graph lifecycle commands\nSubcommands: ${subcommandsFor("graph")}`)
    .option("--json", "JSON output")
    .example(leafUsageFor("graph"))
    .action((subcommand: string | undefined, args: string | string[] | undefined, _opts: { json?: boolean }) => {
      if (!subcommand) {
        // Bare `gk graph` prints usage and exits 0 — same surface as `gk memory`.
        console.log(
          `gk graph — graph lifecycle commands\n\nUsage:\n  gk graph <subcommand> [args...]\n\nSubcommands:\n${leafUsageFor("graph")}\n\nOptions:\n  --json  JSON output`,
        );
        return;
      }
      if (subcommand === "topologies") {
        const topologies = TOPOLOGY_NAMES.map((name) => {
          const template = graphTemplate(name);
          const descMatch = template.match(/^ {2}description: (.+)$/m);
          return {
            name,
            description: descMatch ? descMatch[1] : name,
            config_keys: getTopologyConfigKeys(name),
          };
        });
        emit(ok({ topologies }));
      } else if (subcommand === "list") {
        try {
          const skipped: Array<{ id: string; file: string }> = [];
          const sessions = listSessionGraphs(process.cwd(), (entry) => skipped.push(entry));
          const active = getActiveGraphId();
          if (active !== null && !sessions.some((s) => s.id === active)) {
            // Dangling pointer (spec §6): fail fast when active names a missing file.
            // Existence check only — schema validity stays out of a listing command.
            throw new GraphKitError("ACTIVE_POINTER_DANGLING", `Active pointer "${active}" has no graph file`, {
              id: active,
              baseDir: process.cwd(),
              available: sessions.map((s) => s.id),
            });
          }
          emit(ok({ sessions, active }));
          if (skipped.length > 0) {
            console.warn(
              `warning: skipped ${skipped.length} unparseable session file(s): ${skipped.map((s) => s.file).join(", ")}`,
            );
          }
        } catch (e) {
          emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("LIST_ERROR", String(e)));
        }
      } else if (subcommand === "switch") {
        const id = Array.isArray(args) ? args[0] : args;
        try {
          if (!id) {
            emit(fail("MISSING_ARG", "graph switch requires a session graph id"));
            return;
          }
          setActiveGraphId(id);
          emit(ok({ active: id }));
        } catch (e) {
          emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("SWITCH_ERROR", String(e)));
        }
      } else if (subcommand === "show") {
        const id = Array.isArray(args) ? args[0] : args;
        try {
          // Explicit id resolves through listSessionGraphs so user input is never
          // joined into a path — traversal ids simply never match an entry.
          const entry = id ? listSessionGraphs().find((s) => s.id === id) : null;
          let raw: string;
          let resolvedId: string;
          let resolvedPath: string;
          if (entry) {
            raw = readFileSync(entry.path, "utf-8");
            resolvedId = entry.id;
            resolvedPath = entry.path;
          } else if (id) {
            throw new GraphKitError("GRAPH_NOT_FOUND", `No session graph with id "${id}"`, {
              id,
              available: listSessionGraphs().map((s) => s.id),
            });
          } else {
            const active = loadActiveGraph();
            raw = readFileSync(active.path, "utf-8");
            resolvedId = active.id;
            resolvedPath = active.path;
          }
          emit(ok({ id: resolvedId, path: resolvedPath, graph: YAML.parse(raw) }));
        } catch (e) {
          emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("SHOW_ERROR", String(e)));
        }
      } else if (subcommand === "inspect") {
        const topology = Array.isArray(args) ? args[0] : args;
        if (!topology || !TOPOLOGY_NAMES.includes(topology as TopologyName)) {
          emit(
            fail("UNKNOWN_TOPOLOGY", `"${topology ?? ""}" is not a canonical topology`, { available: TOPOLOGY_NAMES }),
          );
          return;
        }
        emit(ok({ topology, config_keys: getTopologyConfigKeys(topology as TopologyName) }));
      } else if (subcommand === "new") {
        const topology = Array.isArray(args) ? args[0] : args;
        if (!topology || !TOPOLOGY_NAMES.includes(topology as TopologyName)) {
          emit(
            fail("UNKNOWN_TOPOLOGY", `"${topology ?? ""}" is not a canonical topology`, { available: TOPOLOGY_NAMES }),
          );
          return;
        }
        // Emit a valid graph.yaml template for the topology to stdout
        const template = graphTemplate(topology as TopologyName);
        console.log(template);
      } else if (subcommand === "ascii") {
        // Instant ASCII diagram — no model, no rendering pipeline. Validated like
        // `graph waves` so the renderer sees exactly what the executor would run.
        const file = Array.isArray(args) ? args[0] : args;
        try {
          const graph = resolveGraph(process.cwd(), file);
          const findings = validateGraph(graph, process.cwd());
          if (findings.some(isBlocking)) {
            emit(fail("VALIDATION_FAILED", "graph has findings", { issues: findings }));
            return;
          }
          console.log(renderAscii(graph));
        } catch (e) {
          emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("ASCII_ERROR", String(e)));
        }
      } else if (subcommand === "svg") {
        const file = Array.isArray(args) ? args[0] : args;
        try {
          const graph = resolveGraph(process.cwd(), file);
          const findings = validateGraph(graph, process.cwd());
          if (findings.some(isBlocking)) {
            emit(fail("VALIDATION_FAILED", "graph has findings", { issues: findings }));
            return;
          }
          const svg = renderSvg(graph);
          const outDir = join(process.cwd(), ".graphkit", "diagrams");
          mkdirSync(outDir, { recursive: true });
          const outPath = join(outDir, `${(graph.metadata?.name || "graph").replace(/[^a-zA-Z0-9._-]+/g, "-")}.svg`);
          writeFileSync(outPath, svg);
          emit(ok({ svg: outPath }));
        } catch (e) {
          emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("SVG_ERROR", String(e)));
        }
      } else if (subcommand === "waves") {
        // Output topological wave structure for direct execution
        // Each wave = nodes that can run in parallel (all deps satisfied)
        const file = Array.isArray(args) ? args[0] : args;
        try {
          const resolved = resolveGraphPath(process.cwd(), file).path;
          const graph = loadGraph(resolved);
          const findings = validateGraph(graph, process.cwd());
          if (findings.some(isBlocking)) {
            emit(fail("VALIDATION_FAILED", "graph has findings", { issues: findings }));
            return;
          }
          // Planner IR: waves, curator interleave, node payloads, and
          // topology_config all derive from one compiler function.
          const plan = planGraph(graph, { source: resolved });

          const payload: Record<string, unknown> = {
            graph: graph.metadata?.name,
            topology: graph.topology,
            topology_config: plan.topology_config,
            total_waves: plan.waves.length,
            total_nodes: Object.keys(graph.nodes).length,
            waves: plan.waves.map((w) => ({
              wave: w.index,
              parallel: w.parallel,
              curator: w.curator,
              nodes: w.nodes,
            })),
            evidence_required: graph.evidence?.required_keys || [],
            on_graph_complete: graph.hooks?.on_graph_complete ?? [],
            // Advisory findings ride the ok payload (audit F5) — a typo'd
            // constraint shouldn't require a separate `gk validate` to be seen.
            warnings: findings.filter((f) => !isBlocking(f)),
          };
          if (plan.memory) payload.memory = plan.memory;

          emit(ok(payload));
        } catch (e) {
          emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("WAVES_ERROR", String(e)));
        }
      } else if (subcommand === "agents") {
        // Materialize .omp/agents/gk-<node>.md files so omp's native task
        // discovery can dispatch graph nodes without the gk_dispatch_agent
        // child-process path. Run after `gk run start`, before wave dispatch.
        const file = Array.isArray(args) ? args[0] : args;
        try {
          const graph = resolveGraph(process.cwd(), file);
          const findings = validateGraph(graph, process.cwd());
          if (findings.some(isBlocking)) {
            emit(fail("VALIDATION_FAILED", "graph has findings", { issues: findings }));
            return;
          }
          const agents = materializeNodeAgents(process.cwd(), graph);
          // Same advisory channel as waves (audit F5).
          const warnings = findings.filter((f) => !isBlocking(f));
          emit(ok({ agents, dir: join(process.cwd(), ".omp", "agents"), warnings }));
        } catch (e) {
          emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("AGENTS_ERROR", String(e)));
        }
      } else if (subcommand === "index") {
        (async () => {
          try {
            const mode = Array.isArray(args) ? (args[0] as "fast" | "moderate" | "full" | undefined) : undefined;
            const result = await cbmCall((c) => seamIndexProject()(c, { repoPath: process.cwd(), mode }));
            emit(ok(result));
          } catch (e) {
            emit(cbmFailure(e));
          }
        })();
      } else if (subcommand === "search") {
        (async () => {
          try {
            const pattern = Array.isArray(args) ? args[0] : args;
            if (!pattern) {
              emit(fail("MISSING_ARG", "search requires a pattern argument"));
              return;
            }
            const raw = await cbmCall((c) =>
              c.call<SearchResult>("search_graph", {
                pattern,
                project: Array.isArray(args) ? args[1] : undefined,
              }),
            );
            emit(ok(raw));
          } catch (e) {
            emit(cbmFailure(e));
          }
        })();
      } else if (subcommand === "ask") {
        (async () => {
          try {
            const q = Array.isArray(args) ? args.join(" ") : args;
            if (!q) {
              emit(fail("MISSING_ARG", "ask requires a natural-language question"));
              return;
            }
            // project undefined = CBM derives from cwd, same as `graph search`
            const raw = await cbmCall((c) => routeAndRetrieve(c, q));
            emit(ok(raw));
          } catch (e) {
            emit(cbmFailure(e));
          }
        })();
      } else if (subcommand === "trace") {
        (async () => {
          try {
            const fn = Array.isArray(args) ? args[0] : args;
            if (!fn) {
              emit(fail("MISSING_ARG", "trace requires a function_name argument"));
              return;
            }
            const raw = await cbmCall((c) =>
              c.call<TraceResult>("trace_path", {
                function_name: fn,
                project: Array.isArray(args) ? args[1] : undefined,
                depth: 3,
                direction: "both",
              }),
            );
            emit(ok(raw));
          } catch (e) {
            emit(cbmFailure(e));
          }
        })();
      } else if (subcommand === "query") {
        (async () => {
          try {
            const q = Array.isArray(args) ? args[0] : args;
            if (!q) {
              emit(fail("MISSING_ARG", "query requires a Cypher query argument"));
              return;
            }
            const raw = await cbmCall((c) =>
              c.call<QueryResult>("query_graph", {
                query: q,
                project: Array.isArray(args) ? args[1] : undefined,
              }),
            );
            emit(ok(raw));
          } catch (e) {
            emit(cbmFailure(e));
          }
        })();
      } else {
        emit(
          fail("UNKNOWN_GRAPH_SUBCOMMAND", `Unknown subcommand "${subcommand}". Available: ${subcommandsFor("graph")}`),
        );
      }
    });
}
