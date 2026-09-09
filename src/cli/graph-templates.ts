import type { TopologyName } from "../schemas/topology/index.js";

// Valid graph.yaml templates for each topology — emitted by `gk graph new <topology>`
// ponytail: pure data module (type-only import, zero runtime deps) so the CLI
// surface stays cheap to load and the templates are trivially testable.
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
