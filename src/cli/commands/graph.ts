import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { CBM_UNAVAILABLE_MSG, type CbmClient, createCbmClient } from "../../cbm/client.js";
import type { QueryResult, SearchResult, TraceResult } from "../../cbm/contract.js";
import { indexProject } from "../../cbm/index.js";
import { routeAndRetrieve } from "../../cbm/route.js";
import { compileGraph } from "../../compiler/emitter.js";
import { validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import { GraphSchema } from "../../schemas/graph.schema.js";
import { getTopologyConfigKeys, TOPOLOGY_NAMES, type TopologyName } from "../../schemas/topology/index.js";
import { getActiveGraphId, listSessionGraphs, loadActiveGraph, setActiveGraphId } from "../../store/index.js";
import { renderAscii } from "../ascii.js";
import { subcommandsFor } from "../command-registry.js";
import { fail, ok } from "../output.js";
import { renderSvg } from "../svg.js";
import { templatesDir } from "./kit.js";

// ponytail: DI seam for tests — avoids module-mock bleed across test files.
let _cbmClientFactory: () => CbmClient = () => createCbmClient();
let _indexProjectFn: typeof indexProject = indexProject;
/** @internal test seam — inject client + index implementations. */
export function _setCbmSeam(opts: { clientFactory?: () => CbmClient; indexProject?: typeof indexProject }) {
  if (opts.clientFactory) _cbmClientFactory = opts.clientFactory;
  if (opts.indexProject) _indexProjectFn = opts.indexProject;
}
/** @internal test seam — restore real implementations. */
export function _resetCbmSeam() {
  _cbmClientFactory = () => createCbmClient();
  _indexProjectFn = indexProject;
}

// Own the create→call→close lifecycle so a thrown call can't leak the spawned
// CBM child process (mirrors memory.ts indexMemory's try/finally).
async function cbmCall<T>(fn: (client: CbmClient) => Promise<T>): Promise<T> {
  const client = _cbmClientFactory();
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

export function loadGraph(file: string) {
  const raw = readFileSync(file, "utf-8");
  const doc = YAML.parse(raw);
  const parsed = GraphSchema.safeParse(doc);
  if (!parsed.success) {
    throw new GraphKitError("SCHEMA_INVALID", "graph.yaml failed schema validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

// Valid graph.yaml templates for each topology — emitted by `gk graph new <topology>`
function graphTemplate(topology: TopologyName): string {
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
limits:
  max_workers: 5
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
limits:
  max_iterations: 10
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
        const graph = loadGraph(file ?? join(process.cwd(), "graph.yaml"));
        const findings = validateGraph(graph, process.cwd());
        if (findings.length > 0) {
          console.log(JSON.stringify(fail("VALIDATION_FAILED", "graph has findings", { findings })));
          process.exit(1);
          return;
        }
        console.log(JSON.stringify(ok({ valid: true, topology: graph.topology })));
      } catch (e) {
        console.log(
          JSON.stringify(
            e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("VALIDATE_ERROR", String(e)),
          ),
        );
        process.exit(1);
      }
    });

  cli
    .command("compile [file]", "Compile graph.yaml to a .workflow.js script")
    .option("--output <path>", "Output path (default .claude/workflows/{name}.workflow.js)")
    .option("--json", "JSON output")
    .action((file, opts) => {
      try {
        const graph = loadGraph(file ?? join(process.cwd(), "graph.yaml"));
        const findings = validateGraph(graph, process.cwd());
        if (findings.length > 0) {
          console.log(JSON.stringify(fail("VALIDATION_FAILED", "fix findings before compile", { findings })));
          process.exit(1);
          return;
        }
        const script = compileGraph(graph, templatesDir());
        const outPath =
          opts.output ?? join(process.cwd(), ".claude", "workflows", `${graph.metadata.name}.workflow.js`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, script);
        // F9: human mode voices the artifact path so the build is visible; --json stays structured.
        if (opts.json) {
          console.log(JSON.stringify(ok({ compiled: outPath, topology: graph.topology })));
        } else {
          console.log(`compiled ${outPath}`);
        }
      } catch (e) {
        console.log(JSON.stringify(fail("COMPILE_ERROR", String(e))));
        process.exit(1);
      }
    });

  cli
    .command("graph <subcommand> [args...]", `Graph lifecycle commands\nSubcommands: ${subcommandsFor("graph")}`)
    .option("--json", "JSON output")
    .action((subcommand: string, args: string | string[] | undefined, opts: { json?: boolean }) => {
      if (subcommand === "list") {
        // Session graphs (design §3.4). Canonical topologies stay discoverable via
        // `graph inspect <name>` / `graph new <name>` (the inspect error lists all).
        try {
          const sessions = listSessionGraphs();
          const active = getActiveGraphId();
          if (opts.json) {
            console.log(JSON.stringify(ok({ sessions, active })));
          } else if (sessions.length === 0) {
            console.log("no session graphs — run `gk init-graph` or `gk template materialize`");
          } else {
            const idW = Math.max("id".length, ...sessions.map((s) => s.id.length));
            const nameW = Math.max("name".length, ...sessions.map((s) => s.name.length));
            const taskW = Math.max("task".length, ...sessions.map((s) => (s.task ?? "").length));
            console.log(`${"id".padEnd(idW)}  ${"name".padEnd(nameW)}  ${"task".padEnd(taskW)}  created`);
            for (const s of sessions) {
              const mark = s.id === active ? "*" : " ";
              console.log(
                `${mark}${s.id.padEnd(idW - 1)}  ${s.name.padEnd(nameW)}  ${(s.task ?? "").padEnd(taskW)}  ${s.createdAt.toISOString()}`,
              );
            }
          }
        } catch (e) {
          console.log(
            JSON.stringify(
              e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("LIST_ERROR", String(e)),
            ),
          );
          process.exit(1);
        }
      } else if (subcommand === "switch") {
        const id = Array.isArray(args) ? args[0] : args;
        try {
          if (!id) {
            console.log(JSON.stringify(fail("MISSING_ARG", "graph switch requires a session graph id")));
            process.exit(1);
            return;
          }
          setActiveGraphId(id);
          if (opts.json) {
            console.log(JSON.stringify(ok({ active: id })));
          } else {
            console.log(`active -> ${id}`);
          }
        } catch (e) {
          console.log(
            JSON.stringify(
              e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("SWITCH_ERROR", String(e)),
            ),
          );
          process.exit(1);
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
          if (opts.json) {
            console.log(JSON.stringify(ok({ id: resolvedId, path: resolvedPath, graph: YAML.parse(raw) })));
          } else {
            console.log(raw.trimEnd());
          }
        } catch (e) {
          console.log(
            JSON.stringify(
              e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("SHOW_ERROR", String(e)),
            ),
          );
          process.exit(1);
        }
      } else if (subcommand === "inspect") {
        const topology = Array.isArray(args) ? args[0] : args;
        if (!topology || !TOPOLOGY_NAMES.includes(topology as TopologyName)) {
          console.log(
            JSON.stringify(
              fail("UNKNOWN_TOPOLOGY", `"${topology ?? ""}" is not a canonical topology`, {
                available: TOPOLOGY_NAMES,
              }),
            ),
          );
          process.exit(1);
          return;
        }
        console.log(JSON.stringify(ok({ topology, config_keys: getTopologyConfigKeys(topology as TopologyName) })));
      } else if (subcommand === "new") {
        const topology = Array.isArray(args) ? args[0] : args;
        if (!topology || !TOPOLOGY_NAMES.includes(topology as TopologyName)) {
          console.log(
            JSON.stringify(
              fail("UNKNOWN_TOPOLOGY", `"${topology ?? ""}" is not a canonical topology`, {
                available: TOPOLOGY_NAMES,
              }),
            ),
          );
          process.exit(1);
          return;
        }
        // Emit a valid graph.yaml template for the topology to stdout
        const template = graphTemplate(topology as TopologyName);
        console.log(template);
      } else if (subcommand === "ascii") {
        // Instant ASCII diagram — no model, no rendering pipeline
        const file = Array.isArray(args) ? args[0] : args;
        try {
          const out = renderAscii(file ?? join(process.cwd(), "graph.yaml"));
          console.log(out);
        } catch (e) {
          console.log(JSON.stringify(fail("ASCII_ERROR", String(e))));
          process.exit(1);
        }
      } else if (subcommand === "svg") {
        const file = Array.isArray(args) ? args[0] : args;
        try {
          const resolved = file ?? join(process.cwd(), "graph.yaml");
          const svg = renderSvg(resolved);
          const outDir = join(process.cwd(), ".graphkit", "diagrams");
          mkdirSync(outDir, { recursive: true });
          const graph = YAML.parse(readFileSync(resolved, "utf-8"));
          const outPath = join(outDir, `${graph.metadata?.name || "graph"}.svg`);
          writeFileSync(outPath, svg);
          console.log(JSON.stringify(ok({ svg: outPath })));
        } catch (e) {
          console.log(JSON.stringify(fail("SVG_ERROR", String(e))));
          process.exit(1);
        }
      } else if (subcommand === "waves") {
        // Output topological wave structure for direct execution
        // Each wave = nodes that can run in parallel (all deps satisfied)
        const file = Array.isArray(args) ? args[0] : args;
        try {
          const resolved = file ?? join(process.cwd(), "graph.yaml");
          const graph = loadGraph(resolved);
          const findings = validateGraph(graph, process.cwd());
          if (findings.length > 0) {
            console.log(JSON.stringify(fail("VALIDATION_FAILED", "graph has findings", { findings })));
            process.exit(1);
            return;
          }
          const nodes = graph.nodes || {};
          const ids = Object.keys(nodes);

          // Memory-augmented: the Curator node interleaves at cadence (execute-path
          // equivalent of memory-augmented.workflow.js's wrappedAgent, which only
          // runs under the Workflow tool). Pull the curator out of the Kahn sort and
          // re-insert it as its own interleave waves so /gk:execute can dispatch it.
          const isMem = graph.topology === "memory-augmented";
          const memCfg = isMem ? graph.topology_config?.memory || {} : {};
          const curatorName = isMem ? memCfg.curator_node || "curator" : null;
          const cadence = memCfg.cadence || "on_node_complete";
          const every = memCfg.every || 1;
          const hasCurator = curatorName !== null && Object.hasOwn(nodes, curatorName);
          const actionIds = hasCurator ? ids.filter((id) => id !== curatorName) : ids;

          // Kahn's algorithm over action nodes → action waves
          const completed = new Set<string>();
          const actionWaves: string[][] = [];
          while (completed.size < actionIds.length) {
            const ready = actionIds.filter((id) => {
              if (completed.has(id)) return false;
              const deps = nodes[id]?.depend_on || [];
              return deps.every((d: string) => completed.has(d));
            });
            if (ready.length === 0) break;
            actionWaves.push(ready);
            ready.forEach((id) => {
              completed.add(id);
            });
          }

          if (completed.size < actionIds.length) {
            const unresolved = actionIds.filter((id) => !completed.has(id));
            console.log(
              JSON.stringify(
                fail("WAVES_INCOMPLETE", `unresolved nodes after topological sort: ${unresolved.join(", ")}`, {
                  unresolved,
                  hint: "cycle or dependency on an excluded node",
                }),
              ),
            );
            process.exit(1);
            return;
          }

          // Interleave curator waves at cadence; always finish with one end-of-run curation.
          type PlanWave = { kind: "action"; ids: string[] } | { kind: "curator" };
          const plan: PlanWave[] = [];
          let completedActions = 0;
          let lastCuratedAt = 0;
          actionWaves.forEach((w) => {
            plan.push({ kind: "action", ids: w });
            completedActions += w.length;
            if (hasCurator) {
              const fire =
                cadence === "on_node_complete" ||
                (cadence === "every" && Math.floor(completedActions / every) > Math.floor(lastCuratedAt / every));
              if (fire) {
                plan.push({ kind: "curator" });
                lastCuratedAt = completedActions;
              }
            }
          });
          // End-of-run curation: fire if the last crossing happened at a multiple of
          // `every` but the current cumulative total no longer is — a threshold was
          // passed since the last fire.
          if (
            hasCurator &&
            actionWaves.length > 0 &&
            lastCuratedAt > 0 &&
            lastCuratedAt < completedActions &&
            completedActions % every !== 0 &&
            lastCuratedAt % every === 0
          ) {
            plan.push({ kind: "curator" });
          }

          const nodeObj = (id: string) => ({
            id,
            agent: nodes[id]?.agent,
            model: nodes[id]?.model || "sonnet",
            objective: nodes[id]?.objective?.trim() || "",
            tools: nodes[id]?.tools || [],
            skills: nodes[id]?.skills || [],
            refs: nodes[id]?.refs || [],
            depend_on: nodes[id]?.depend_on || [],
            loop: nodes[id]?.loop || null,
            evidence: nodes[id]?.evidence || [],
          });

          // Materialize waves; curator waves carry `curator: true` + the recall skill.
          const waveData = plan.map((pw, i) => {
            if (pw.kind === "curator") {
              const skills = Array.from(new Set([...(nodes[curatorName]?.skills || []), "gk-recall"]));
              return { wave: i, parallel: false, curator: true, nodes: [{ ...nodeObj(curatorName), skills }] };
            }
            return { wave: i, parallel: pw.ids.length > 1, nodes: pw.ids.map(nodeObj) };
          });

          const payload: Record<string, unknown> = {
            graph: graph.metadata?.name,
            topology: graph.topology,
            total_waves: waveData.length,
            total_nodes: ids.length,
            waves: waveData,
            evidence_required: graph.evidence?.required_keys || [],
          };
          if (hasCurator) {
            payload.memory = {
              curator_node: curatorName,
              cadence,
              every,
              recall_topk: memCfg.recall_topk ?? 5,
              expire_policy: memCfg.expire_policy ?? "act_r",
              null_intervention_allowed: memCfg.null_intervention_allowed ?? true,
            };
          }

          console.log(JSON.stringify(ok(payload)));
        } catch (e) {
          console.log(
            JSON.stringify(
              e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("WAVES_ERROR", String(e)),
            ),
          );
          process.exit(1);
        }
      } else if (subcommand === "index") {
        (async () => {
          try {
            const mode = Array.isArray(args) ? (args[0] as "fast" | "moderate" | "full" | undefined) : undefined;
            const result = await cbmCall((c) => _indexProjectFn(c, { repoPath: process.cwd(), mode }));
            console.log(JSON.stringify(ok(result)));
          } catch (e) {
            console.log(JSON.stringify(cbmFailure(e)));
            process.exit(1);
          }
        })();
      } else if (subcommand === "search") {
        (async () => {
          try {
            const pattern = Array.isArray(args) ? args[0] : args;
            if (!pattern) {
              console.log(JSON.stringify(fail("MISSING_ARG", "search requires a pattern argument")));
              return;
            }
            const raw = await cbmCall((c) =>
              c.call<SearchResult>("search_graph", {
                pattern,
                project: Array.isArray(args) ? args[1] : undefined,
              }),
            );
            console.log(JSON.stringify(ok(raw)));
          } catch (e) {
            console.log(JSON.stringify(cbmFailure(e)));
            process.exit(1);
          }
        })();
      } else if (subcommand === "ask") {
        (async () => {
          try {
            const q = Array.isArray(args) ? args.join(" ") : args;
            if (!q) {
              console.log(JSON.stringify(fail("MISSING_ARG", "ask requires a natural-language question")));
              return;
            }
            // project undefined = CBM derives from cwd, same as `graph search`
            const raw = await cbmCall((c) => routeAndRetrieve(c, q));
            console.log(JSON.stringify(ok(raw)));
          } catch (e) {
            console.log(JSON.stringify(cbmFailure(e)));
            process.exit(1);
          }
        })();
      } else if (subcommand === "trace") {
        (async () => {
          try {
            const fn = Array.isArray(args) ? args[0] : args;
            if (!fn) {
              console.log(JSON.stringify(fail("MISSING_ARG", "trace requires a function_name argument")));
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
            console.log(JSON.stringify(ok(raw)));
          } catch (e) {
            console.log(JSON.stringify(cbmFailure(e)));
            process.exit(1);
          }
        })();
      } else if (subcommand === "query") {
        (async () => {
          try {
            const q = Array.isArray(args) ? args[0] : args;
            if (!q) {
              console.log(JSON.stringify(fail("MISSING_ARG", "query requires a Cypher query argument")));
              return;
            }
            const raw = await cbmCall((c) =>
              c.call<QueryResult>("query_graph", {
                query: q,
                project: Array.isArray(args) ? args[1] : undefined,
              }),
            );
            console.log(JSON.stringify(ok(raw)));
          } catch (e) {
            console.log(JSON.stringify(cbmFailure(e)));
            process.exit(1);
          }
        })();
      } else {
        console.log(
          JSON.stringify(
            fail(
              "UNKNOWN_GRAPH_SUBCOMMAND",
              `Unknown subcommand "${subcommand}". Available: ${subcommandsFor("graph")}`,
            ),
          ),
        );
        process.exit(1);
      }
    });
}
