import type { Run, Verdict, Workflow } from "../schemas.js";
import { evaluateCondition, type Scope } from "./expression.js";

/**
 * Pure transition resolver. Performs no I/O and mutates nothing: it reads the
 * workflow topology, the current run position, and the evaluation scope, and
 * returns a decision. Only this function chooses destinations.
 */

export interface TransitionInput {
  workflow: Workflow;
  run: Run;
  scope: Scope;
  /** Deterministic node that just completed successfully. */
  completed?: string;
  /** Node that just failed. */
  failed?: string;
  /** Verdict reported by the completing node. */
  verdict?: Verdict;
}

export interface ForwardDecision {
  next: string[];
  /** True when routing to a retry of the failed node. */
  retry?: boolean;
  /**
   * Candidate failure count (run.failures + 1) when a failure occurred, or the
   * run's current failure count otherwise. Caller persists it to the run.
   */
  failures?: number;
}

export interface TerminalDecision {
  terminal: true;
  verdict: Verdict;
}

export type TransitionDecision = ForwardDecision | TerminalDecision;

function targets(to: Workflow["edges"][number]["to"]): string[] {
  return Array.isArray(to) ? to : [to];
}

type Resolved = { forward: true; next: string[] } | { forward: false; verdict: Verdict };

/**
 * Deterministically advance from `node`, skipping any target already settled in
 * `settled` so a settled node is never scheduled again. Returns the unsettled
 * direct targets (fanout preserved) or, when every direct target is settled,
 * follows through the settled chain until an unsettled node or a terminal.
 * The `visited` set guards against cycles.
 */
function resolveNode(
  workflow: Workflow,
  node: string,
  scope: Scope,
  settled: Set<string>,
  visited: Set<string>,
): Resolved {
  if (visited.has(node)) return { forward: false, verdict: "failed" };
  const nextVisited = new Set(visited);
  nextVisited.add(node);

  const terminal = (workflow.terminal ?? []).find((t) => t.node === node)?.verdict;
  if (terminal) return { forward: false, verdict: terminal };

  const candidates = (workflow.edges ?? []).filter((e) => e.from === node);
  let lastTerminal: Verdict | undefined;
  for (const candidate of candidates) {
    if (candidate.when && !evaluateCondition(candidate.when, scope)) continue;
    if (candidate.verdict) return { forward: false, verdict: candidate.verdict };
    const next = targets(candidate.to);
    const unresolved = next.filter((target) => !settled.has(target));
    if (unresolved.length) return { forward: true, next: unresolved };
    // All explicit targets are settled; follow through each settled chain.
    for (const target of next) {
      const resolved = resolveNode(workflow, target, scope, settled, nextVisited);
      if (resolved.forward) return resolved;
      lastTerminal = resolved.verdict;
    }
  }
  return { forward: false, verdict: lastTerminal ?? "failed" };
}

/**
 * Select the next node(s) after a completed or failed node. Refuses to advance
 * a run that has already reached a terminal verdict. Only this function
 * chooses destinations; it performs no I/O.
 */
export function selectTransition(input: TransitionInput): TransitionDecision {
  const { workflow, run, scope, verdict } = input;

  // Refuse to advance past a terminal verdict.
  if (run.verdict !== null && run.verdict !== undefined) return { terminal: true, verdict: run.verdict };

  if (input.failed) return routeOnError(workflow, input.failed, verdict ?? "failed", run.failures);

  const completed = input.completed;
  if (!completed) return { terminal: true, verdict: run.verdict ?? "failed" };

  const settled = new Set(run.completed_deterministic_nodes ?? []);

  // The completing node is now settled; skip over it so it cannot reschedule.
  settled.add(completed);
  const resolved = resolveNode(workflow, completed, scope, settled, new Set<string>());
  if (resolved.forward) return { next: resolved.next };
  return { terminal: true, verdict: resolved.verdict };
}

function routeOnError(workflow: Workflow, from: string, verdict: Verdict, failures: number): TransitionDecision {
  const edge = (workflow.edges ?? []).find((e) => e.from === from);
  const candidateFailures = failures + 1;
  // Bounded retry: only retry within `retry.max`; the candidate counter is
  // incremented before eligibility is evaluated.
  if (edge?.retry && edge.retry.max > 0 && edge.retry.on.includes(verdict) && candidateFailures <= edge.retry.max) {
    return { next: [from], retry: true, failures: candidateFailures };
  }
  if (edge?.on_error) return { next: targets(edge.on_error), failures: candidateFailures };
  return { terminal: true, verdict: "failed" };
}
