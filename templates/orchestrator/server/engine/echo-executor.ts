// The P1 test executor (DESIGN §4.1 / acceptance list). A DETERMINISTIC
// NodeExecutor: given a node + resolved deps it returns a deterministic output
// WITHOUT calling any model. It can emit an ARRAY (so a fanout can expand) and
// supports a small CONFIGURABLE delay so concurrency is observable in
// timestamps — but the delay NEVER affects topology or artifact ids.
//
// P2 plugs real executors (vLLM / claude-code) into the SAME NodeExecutor seam.

import type {
  NodeExecutionInput,
  NodeExecutionResult,
  NodeExecutor,
} from "./types.js";

/**
 * Resolve the observable delay for a node, in ms. Pure (derives only from node
 * config + the run-time fanoutIndex/iteration, never from the clock).
 *
 * - `echoDelayMs`       constant base delay.
 * - `echoDelayPerIndexMs` adds (fanoutIndex × this) so siblings finish at
 *   staggered times — used to make pipeline interleave observable (a low-index
 *   chain races ahead of a high-index sibling).
 */
function resolveDelay(input: NodeExecutionInput, defaultMs: number): number {
  const env = input.node.runtime?.env ?? {};
  let base = defaultMs;
  const fromEnv = env.echoDelayMs;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n >= 0) base = n;
  }
  const perIdx = env.echoDelayPerIndexMs;
  if (typeof perIdx === "string" && perIdx.trim() !== "") {
    const n = Number(perIdx);
    if (Number.isFinite(n) && n >= 0) base += input.fanoutIndex * n;
  }
  return base;
}

/** Sleep that respects an abort signal (used only for observable timing). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal.aborted) {
      clearTimeout(t);
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Build the deterministic echo output. Topology-affecting fields (array length,
 * keys) derive ONLY from node config + dep values, never from timing.
 *
 * - A node whose config requests an array (`runtime.env.echoArray` = "<n>" or a
 *   dep output that is already an array) returns an array, so fanout can fan.
 * - Otherwise returns a stable object echoing the node + its deps.
 */
function buildOutput(input: NodeExecutionInput): unknown {
  const { node, deps } = input;
  const env = node.runtime?.env ?? {};

  // Explicit array emitter for discovery/fanout sources.
  const arrSpec = env.echoArray;
  if (typeof arrSpec === "string" && arrSpec.trim() !== "") {
    // "echoArray" may be a count "3" or a JSON array literal.
    const asNum = Number(arrSpec);
    if (
      Number.isInteger(asNum) &&
      asNum >= 0 &&
      String(asNum) === arrSpec.trim()
    ) {
      return Array.from({ length: asNum }, (_, i) => ({
        id: `${node.id}-item-${i}`,
        index: i,
      }));
    }
    try {
      const parsed = JSON.parse(arrSpec);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to default object output
    }
  }

  const base: Record<string, unknown> = {
    node: node.id,
    title: node.title,
    prompt: node.prompt ?? null,
  };
  // Surface the reasoning-effort hint the scheduler passed through so node-get
  // can prove the chosen value (DESIGN §1.6; a real executor maps it onto
  // runAgentLoop's reasoning-effort option).
  if (input.effort !== undefined) base.effort = input.effort;
  // Echo each dep output so downstream nodes can reference it.
  if (Object.keys(deps).length > 0) base.deps = deps;
  // For a fanout child, echo the item it processed (index-preserving chains).
  if (input.item !== undefined) {
    base.item = input.item;
    base.fanoutIndex = input.fanoutIndex;
  }
  if (input.iteration > 0) base.iteration = input.iteration;
  return base;
}

/**
 * A deterministic echo executor. `invokeCount` is exposed so resume tests can
 * assert that replayed (already-done) NodeRuns are NOT re-invoked.
 */
export class EchoExecutor implements NodeExecutor {
  readonly kind = "echo";
  private readonly defaultDelayMs: number;
  /** Spy: how many times invoke() actually ran an executor body. */
  invokeCount = 0;
  /** Spy: which journal keys were invoked (for fine-grained assertions). */
  readonly invokedKeys: string[] = [];

  constructor(defaultDelayMs = 0) {
    this.defaultDelayMs = defaultDelayMs;
  }

  async invoke(
    input: NodeExecutionInput,
    signal: AbortSignal,
  ): Promise<NodeExecutionResult> {
    this.invokeCount += 1;
    this.invokedKeys.push(
      `${input.node.id}#${input.iteration}#${input.fanoutIndex}`,
    );
    const delay = resolveDelay(input, this.defaultDelayMs);
    await sleep(delay, signal);
    return { output: buildOutput(input), tokensSpent: 0 };
  }
}
