import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { compileGraph } from "../../compiler/emitter.js";
import { validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import { GraphSchema } from "../../schemas/graph.schema.js";
import { getTopologyConfigKeys, TOPOLOGY_NAMES, type TopologyName } from "../../schemas/topology/index.js";
import { fail, ok } from "../output.js";
import { templatesDir } from "./kit.js";
import { renderAscii } from "../ascii.js";

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
        console.log(JSON.stringify(ok({ compiled: outPath, topology: graph.topology })));
      } catch (e) {
        console.log(JSON.stringify(fail("COMPILE_ERROR", String(e))));
        process.exit(1);
      }
    });

  cli
    .command("graph <subcommand> [args...]", "Graph lifecycle commands")
    .option("--json", "JSON output")
    .action((subcommand: string, args: string | string[] | undefined) => {
      if (subcommand === "list") {
        console.log(JSON.stringify(ok({ topologies: TOPOLOGY_NAMES })));
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
      } else {
        console.log(
          JSON.stringify(
            fail(
              "UNKNOWN_GRAPH_SUBCOMMAND",
              `Unknown subcommand "${subcommand}". Use "graph list" or "graph inspect <topology>"`,
            ),
          ),
        );
        process.exit(1);
      }
    });
}
