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
  /** True when routing to a retry of the failed node; caller increments failures. */
  retry?: boolean;
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

function routeOnError(workflow: Workflow, from: string, verdict: Verdict): TransitionDecision {
  const edge = (workflow.edges ?? []).find((e) => e.from === from);
  // Bounded retry: a retry-eligible verdict reroutes to the same node. The
  // caller increments the failure counter; this is pure routing.
  if (edge?.retry && edge.retry.max > 0 && edge.retry.on.includes(verdict)) {
    return { next: [from], retry: true };
  }
  if (edge?.on_error) return { next: targets(edge.on_error) };
  return { terminal: true, verdict: "failed" };
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

  if (input.failed) return routeOnError(workflow, input.failed, verdict ?? "failed");

  const completed = input.completed;
  if (!completed) return { terminal: true, verdict: run.verdict ?? "failed" };

  const terminal = (workflow.terminal ?? []).find((t) => t.node === completed)?.verdict;
  if (terminal) return { terminal: true, verdict: terminal };

  // Conditional edges: the first matching `when` wins; unconditional passes.
  const candidates = (workflow.edges ?? []).filter((e) => e.from === completed);
  for (const candidate of candidates) {
    if (!candidate.when || evaluateCondition(candidate.when, scope)) {
      if (candidate.verdict) return { terminal: true, verdict: candidate.verdict };
      return { next: targets(candidate.to) };
    }
  }
  return { terminal: true, verdict: "failed" };
}
