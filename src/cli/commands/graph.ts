import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { planGraph } from "../../compiler/plan.js";
import { isBlocking, validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import type { Graph } from "../../schemas/graph.schema.js";
import { type GraphTemplate, materializeTemplate } from "../../schemas/template.schema.js";
import { getTopologyConfigKeys, TOPOLOGY_NAMES, type TopologyName } from "../../schemas/topology/index.js";
import { getActiveGraphId, listSessionGraphs, loadActiveGraph, setActiveGraphId } from "../../store/index.js";
import { renderAscii } from "../ascii.js";
import { leafUsageFor, subcommandsFor } from "../command-registry.js";
import { loadGraphDoc, previewGraph, resolveGraph, resolveGraphPath } from "../graph-resolve.js";
import { materializeNodeAgents } from "../node-agents.js";
import { emit, fail, ok, type Result } from "../output.js";
import { renderSvg } from "../svg.js";

// The strict graph loader: templates are not graphs here. run/exec materialize
// session graphs before this ever sees them, so a template reaching loadGraph
// gets the honest TEMPLATE_NOT_GRAPH remedy instead of schema noise.
export function loadGraph(file: string) {
  const doc = loadGraphDoc(file);
  if (doc.kind === "template") {
    throw new GraphKitError(
      "TEMPLATE_NOT_GRAPH",
      `TEMPLATE_NOT_GRAPH: ${file} is a GraphTemplate — preview with gk graph waves|ascii|svg, or materialize first: gk template materialize ${doc.template.metadata.name}`,
      { file, name: doc.template.metadata.name, hint: "materialize first: gk template materialize <name>" },
    );
  }
  return doc.graph;
}

// Template validate (audit F3 + F10): the envelope already passed
// GraphTemplateSchema (loadGraphDoc routed it); the embedded `graph:` body now
// gets the SAME semantic checks as a materialized graph — agent bindings,
// refs, evidence keys — so a typo'd agent fails here, not at materialize
// time. The body is checked defaults-materialized when possible (placeholders
// in value positions resolve; a parameterized agent would false-positive on
// the raw body), falling back to the raw body for defaults-incomplete
// templates. Embedded findings carry a `graph.` path prefix so they are
// distinguishable from envelope issues.
function validateTemplateDoc(template: GraphTemplate, projectRoot: string): Result {
  let embedded: Graph;
  try {
    embedded = materializeTemplate(template, {});
  } catch {
    embedded = template.graph;
  }
  const findings = validateGraph(embedded, projectRoot).map((f) => ({ ...f, path: `graph.${f.path}` }));
  if (findings.some(isBlocking)) {
    return fail("VALIDATION_FAILED", "template's embedded graph has findings", { issues: findings });
  }
  return ok({
    valid: true,
    kind: "template",
    name: template.metadata.name,
    parameters: template.parameters,
    warnings: findings,
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
        // One load, one branch (audit F3 + F10): explicit file args route
        // through loadGraphDoc — templates get envelope + embedded-graph
        // checks; plain graphs the usual path. The no-file bare form resolves
        // the active session graph, which is always a materialized Graph.
        const doc = file
          ? loadGraphDoc(resolveGraphPath(process.cwd(), String(file)).path)
          : { kind: "graph" as const, graph: resolveGraph(process.cwd()) };
        if (doc.kind === "template") {
          emit(validateTemplateDoc(doc.template, process.cwd()));
          return;
        }
        const findings = validateGraph(doc.graph, process.cwd());
        if (findings.some(isBlocking)) {
          emit(fail("VALIDATION_FAILED", "graph has findings", { issues: findings }));
          return;
        }
        emit(ok({ valid: true, topology: doc.graph.topology, warnings: findings.filter((f) => !isBlocking(f)) }));
      } catch (e) {
        emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("VALIDATE_ERROR", String(e)));
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
          const graph = previewGraph(process.cwd(), file).graph;
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
          const graph = previewGraph(process.cwd(), file).graph;
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
          const { path: resolved, graph } = previewGraph(process.cwd(), file);
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
          const graph = previewGraph(process.cwd(), file).graph;
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
      } else {
        emit(
          fail("UNKNOWN_GRAPH_SUBCOMMAND", `Unknown subcommand "${subcommand}". Available: ${subcommandsFor("graph")}`),
        );
      }
    });
}
