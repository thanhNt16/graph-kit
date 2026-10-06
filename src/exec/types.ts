import type { PlannedNode, PlanWave } from "../compiler/plan.js";

// The exec engine's public IR. One engine consumes planGraph(); the Runner
// seam is what lets interactive (host task tool supplies results per node)
// and headless (child-process spawn per node) paths share it — the engine
// never knows which Runner it holds.

/**
 * The dispatch seam: one method, per node. Interactive adapters dispatch via
 * the host's task tool; headless `gk exec` dispatches via spawnDispatch
 * (src/exec/spawn.ts). Engine tracks results either way.
 */
export interface Runner {
  dispatch(node: PlannedNode, ctx: DispatchContext): Promise<DispatchOutcome>;
}

/** What a dispatch came back with — Runner-agnostic, so both seams agree. */
export interface DispatchOutcome {
  ok: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
}

/** Everything a Runner needs to dispatch one node of one run. */
export interface DispatchContext {
  runId: string;
  cwd: string;
  node: PlannedNode;
  attempt: number;
  /** Finished nodes this node depended on, by id — upstream context for the dispatch. */
  upstream: Map<string, NodeRun>;
}

/** Engine's ledger-facing record of one node's fate. Statuses mirror the
 *  TraceLine union plus `landed` (integration stamped). */
export interface NodeRun {
  id: string;
  wave: number;
  status: "ok" | "fail" | "skipped" | "challenge" | "landed";
  outcome?: DispatchOutcome;
  attempts: number;
}

/** One executed wave: the hard barrier is "all nodes of wave N before N+1". */
export interface WaveRun {
  index: number;
  curator: boolean;
  nodes: NodeRun[];
}

/** Engine exit report — status matches RunIndexLine's ledger union. */
export interface RunVerdict {
  status: "merged" | "blocked" | "failed";
  runId: string;
  waves: WaveRun[];
  nodes: NodeRun[];
  unresolved: string[];
}

/**
 * Interactive-path callbacks. Headless runs omit the optional ones (gates
 * auto-skip, challenges defer); the engine holds no judgment — adjudication
 * stays with the host.
 */
export interface InteractiveHooks {
  onWaveStart(w: PlanWave): void;
  onNodeResult(n: NodeRun): void;
  /** Suspend for the user; headless leaves undefined → gate nodes auto-skip. */
  askGate?(node: PlannedNode, gate: NonNullable<PlannedNode["gate"]>): Promise<boolean>;
  /** `CHALLENGE: <node-id|plan> — <evidence>` line, verbatim; verdict is the host's call. */
  askChallenge?(finding: string): Promise<"accept" | "modify" | "reject" | "defer">;
}
