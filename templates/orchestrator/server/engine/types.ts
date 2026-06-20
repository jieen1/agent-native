// Engine core types (DESIGN §4). These describe the in-memory shape the
// deterministic scheduler operates on. Persistence (node_runs / artifacts rows)
// is handled in `store.ts`; the scheduler itself works against this model and
// asks the store to journal transitions.

import type { Node, WorkflowGraph } from "../../shared/types.js";

/** NodeRun lifecycle states (DESIGN §4.1). */
export type NodeRunStatus =
  | "pending"
  | "ready"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "awaiting-approval";

/**
 * The journal identity of a NodeRun (DESIGN §1.7 / §4.1a). A NodeRun is uniquely
 * keyed by (nodeId, iteration, fanoutIndex) within a run. Equal keys are the
 * same logical work; this is what makes pipeline edges index-preserving and
 * resume replay possible.
 */
export interface NodeRunKey {
  nodeId: string;
  iteration: number;
  fanoutIndex: number;
}

/** Serialize a NodeRunKey to a stable string for Map keys. */
export function keyStr(k: NodeRunKey): string {
  return `${k.nodeId}#${k.iteration}#${k.fanoutIndex}`;
}

/** An in-memory NodeRun the scheduler advances and the store persists. */
export interface NodeRunState {
  /** DB id (`nr_...`). Stable for the life of the run. */
  id: string;
  runId: string;
  key: NodeRunKey;
  /** The template node this run executes. */
  node: Node;
  status: NodeRunStatus;
  /** Added at run time (fanout child / loop iteration / subworkflow inline). */
  dynamic: boolean;
  /** artifacts.id of the resolved input snapshot, once running. */
  inputRef: string | null;
  /** artifacts.id of the produced output, once done. */
  outputRef: string | null;
  error: string | null;
  attempts: number;
  tokensSpent: number;
  startedAt: string | null;
  completedAt: string | null;
}

/** A resolved input handed to a NodeExecutor: dep outputs keyed by node id. */
export interface NodeExecutionInput {
  /** This node's own resolved prompt/title context. */
  node: Node;
  /** The output value of each in-scope dependency, keyed by dep node id. */
  deps: Record<string, unknown>;
  /** For a fanout child: the single upstream item this child processes. */
  item?: unknown;
  /** Index within a fanout scope (0 for non-fanout). */
  fanoutIndex: number;
  /** Loop iteration (0 outside a loop). */
  iteration: number;
}

/** What an executor returns. `output` is journaled as the node's artifact. */
export interface NodeExecutionResult {
  output: unknown;
  /** Tokens consumed (echo yields 0; the capture path must exist — §4.2). */
  tokensSpent: number;
}

/**
 * The pluggable unit of work. The deterministic scheduler owns all topology,
 * concurrency, journaling and DAG advancement; an executor only turns a
 * resolved input into an output. P1 ships a deterministic ECHO executor; P2
 * plugs real model/microVM executors into this same seam (DESIGN §4.2).
 *
 * `invoke` MUST NOT make scheduling decisions and MUST be free of topology
 * side effects: given the same input it produces the same `output` and the same
 * artifact id is derived by the scheduler, regardless of wall-clock timing.
 */
export interface NodeExecutor {
  /** Stable executor tag for observability (e.g. "echo", "vllm", "claude-code"). */
  readonly kind: string;
  invoke(
    input: NodeExecutionInput,
    signal: AbortSignal,
  ): Promise<NodeExecutionResult>;
}

/** Concurrency caps (DESIGN §4.1 — build, do not configure). */
export interface ConcurrencyCaps {
  /** Real semaphore for local/tool model calls (default 8). */
  maxConcurrentModelCalls: number;
  /** microVM cap (unused in P1; carried for P2). */
  maxConcurrentVMs: number;
  /** Per-run hard cap on total NodeRuns (runaway backstop). */
  maxTotalNodes: number;
}

export const DEFAULT_CAPS: ConcurrencyCaps = {
  maxConcurrentModelCalls: 8,
  maxConcurrentVMs: 4,
  maxTotalNodes: 1000,
};

/** Inputs that drive a run; the scheduler never reads wall-clock for control. */
export interface RunConfig {
  runId: string;
  templateId: string;
  graph: WorkflowGraph;
  userEmail: string;
  orgId: string | null;
  tokenBudget: number | null;
  /**
   * Explicit deterministic seed (DESIGN §0.2.1). Any value the engine uses for
   * a scheduling decision derives from this, never from RNG/clock. Default
   * fixed so two runs of the same fixture are identical.
   */
  seed: number;
  caps: ConcurrencyCaps;
  /**
   * Observable delay (ms) the echo executor sleeps to make concurrency visible
   * in timestamps. Does NOT affect topology or artifact ids. May be overridden
   * per-node via `node.runtime.env.echoDelayMs` or node config.
   */
  echoDelayMs: number;
}
