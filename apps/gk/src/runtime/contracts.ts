import type { Lease, Limits, Verdict } from "../schemas.js";

/**
 * The four `nextWorkflow` contracts plus the human pause/resume contract.
 * Each contract is a discriminated union on `kind`. `nextWorkflow` performs no
 * I/O except lease issuance/writeback and the dispatch checkpoint it requires.
 */

export interface AgentContract {
  kind: "agent";
  node: string;
  objective: string;
  /** Nodes already settled before this agent, as stable, order-invariant ids. */
  context: Record<string, unknown>;
  tool_allowlist: string[];
  skill: string;
  /** Workflow-level limits the agent must respect. */
  limits: Limits;
  /** Evidence keys the agent must report, in template declaration order. */
  required_evidence: string[];
  output_schema: string;
  output_save_as: string;
  submit_argv: string[];
}

export interface DispatchItem {
  work_item: string;
  lease: Lease;
  node: string;
}

export interface DispatchContract {
  kind: "dispatch";
  worker_skill: string;
  items: DispatchItem[];
  concurrency_ceiling: number;
  join_merge_policy: string;
}

export interface DeterministicContract {
  kind: "deterministic";
  node: string;
  argv: string[];
  output_schemas?: Record<string, string>;
  output_save_as?: Record<string, string>;
}

export interface PausedContract {
  kind: "paused";
  node: string;
  prompt: string;
  actions: string[];
}

export interface TerminalContract {
  kind: "terminal";
  verdict: Verdict;
}

export type WorkflowContract =
  | AgentContract
  | DispatchContract
  | DeterministicContract
  | PausedContract
  | TerminalContract;
