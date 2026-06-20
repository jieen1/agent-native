// The provider-specific EXECUTE seam (DESIGN §7.4.1a stage 4 — the ONLY stage
// that varies by brain). The 7-stage NodeRunner (`node-runner.ts`) owns the
// shared microVM lifecycle (provision → mount → init → … → teardown); it hands
// an already-provisioned, mounted, branch-initialized VM to a `RuntimeExecutor`
// whose single job is to run the model and act through VM-bound tools.
//
// This is DELIBERATELY a different, narrower interface than the scheduler-level
// `NodeExecutor` (`server/engine/types.ts`). The scheduler's `NodeExecutor`
// turns a resolved DAG input into an output and is unaware of VMs; a
// `RuntimeExecutor` is the inside of stage 4 — it receives a live VM handle and
// the runtime that owns it. The `NodeRunnerExecutor` (`node-runner.ts`) is the
// adapter that implements the scheduler's `NodeExecutor` by driving the 7 stages
// and delegating EXECUTE to one of these.

import type { Node } from "../../../shared/types.js";
import type { NodeRuntime, VmHandle } from "../node-runtime.js";

/**
 * The context a {@link RuntimeExecutor} receives at the EXECUTE stage (DESIGN
 * §7.4.1a — `node.executor.run({ vm, node, deps })`). The VM is already
 * provisioned/mounted/branch-initialized by the NodeRunner; the executor only
 * runs the model.
 */
export interface RuntimeExecCtx {
  /** The runtime backend that owns `vm` (exec/spawn/fs side effects go here). */
  runtime: NodeRuntime;
  /** The provisioned VM handle the model's tools act against. */
  vm: VmHandle;
  /** The template node being executed (carries engine/model/prompt/runtime). */
  node: Node;
  /**
   * In-VM working directory the node operates in (its worktree, e.g. `/work`).
   * Tools resolve relative paths here; bash runs here.
   */
  workdir: string;
  /**
   * Resolved dependency outputs keyed by dep node id, plus the per-item value
   * for a fanout child — the same `deps`/`item` the scheduler resolved. The
   * executor folds these into the model prompt.
   */
  deps: Record<string, unknown>;
  /** For a fanout child: the single upstream item this child processes. */
  item?: unknown;
  /** Reasoning-effort hint (§1.6), mapped onto the engine call when supported. */
  effort?: "low" | "medium" | "high";
  /** The run owner's email — needed to scope key resolution + request context. */
  ownerEmail: string;
  /** The run org id (null for single-tenant). */
  orgId: string | null;
  /** Cooperative cancellation — the model loop checks this at boundaries. */
  signal: AbortSignal;
}

/** What a {@link RuntimeExecutor} returns from EXECUTE (DESIGN §7.4.1a stage 5). */
export interface RuntimeExecResult {
  /** The node's produced output (journaled as its artifact). */
  output: unknown;
  /** Tokens consumed by the model (AgentLoopUsage, §4.2.3). */
  tokensSpent: number;
  /** True if the model emitted at least one tool call (proof of real acting). */
  toolCallCount: number;
  /** The model id the executor actually ran (for observability/journaling). */
  model: string;
  /** Free-form per-provider detail (e.g. final assistant text). */
  detail?: Record<string, unknown>;
}

/**
 * The pluggable brain at stage 4 (DESIGN §7.4.1a). One impl per provider:
 *   • VllmExecutor       — host→vLLM `runAgentLoop`, tools = VM acting bridge.
 *   • RemoteApiExecutor  — same shape, a hosted engine + key.
 *   • ClaudeCodeExecutor — `claude --output-format stream-json` IN the VM.
 * The executor NEVER manages the VM lifecycle — it only runs the model.
 */
export interface RuntimeExecutor {
  /** Stable provider tag for observability (e.g. "vllm", "claude-code"). */
  readonly kind: string;
  run(ctx: RuntimeExecCtx): Promise<RuntimeExecResult>;
}
