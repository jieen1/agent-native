// Executor barrel + the brain ROUTER (DESIGN §7.4.1a / IMPLEMENTATION P2b #4).
// Given a node, pick the right `RuntimeExecutor` for the EXECUTE stage:
//
//   ExecutorChoice "claude-code"            → ClaudeCodeExecutor (claude in-VM)
//   ExecutorChoice "engine" → a runtime_config row:
//       kind "vllm"              → VllmExecutor (baseUrl/model from the row)
//       kind "openai-compatible" → VllmExecutor (any OpenAI-compatible endpoint)
//       kind "claude-code"       → ClaudeCodeExecutor
//   ExecutorChoice "engine" → a built-in framework engine id (ai-sdk:*, …)
//                                            → RemoteApiExecutor (hosted API)
//
// The CHOICE itself is resolved by the P0 pure judge
// `resolveNodeExecutorChoice` (executor-choice.ts); this module turns that
// choice + the live runtime_configs rows into a concrete executor instance.

import {
  resolveNodeExecutorChoice,
  type ExecutorChoice,
} from "../executor-choice.js";
import type { Node } from "../../../shared/types.js";
import { ClaudeCodeExecutor } from "./claude-code-executor.js";
import { RemoteApiExecutor } from "./remote-api-executor.js";
import { VllmExecutor } from "./vllm-executor.js";
import type { RuntimeExecutor } from "./types.js";

export type {
  RuntimeExecCtx,
  RuntimeExecResult,
  RuntimeExecutor,
} from "./types.js";
export { VllmExecutor } from "./vllm-executor.js";
export { RemoteApiExecutor } from "./remote-api-executor.js";
export { ClaudeCodeExecutor } from "./claude-code-executor.js";
export { parseClaudeStreamJson } from "./claude-stream.js";
export { buildClaudeCommand } from "./claude-code-executor.js";
export { DEFAULT_VLLM_BASE_URL, DEFAULT_VLLM_MODEL } from "./vllm-executor.js";

/** A saved runtime_config row, narrowed to the fields routing needs. */
export interface RuntimeConfigRow {
  id: string;
  kind: "vllm" | "openai-compatible" | "claude-code";
  baseUrl: string | null;
  model: string | null;
}

/** Build the executor for an already-resolved {@link ExecutorChoice}. */
export function executorForChoice(
  choice: ExecutorChoice,
  runtimeConfigs: readonly RuntimeConfigRow[],
): RuntimeExecutor {
  if (choice.kind === "claude-code") return new ClaudeCodeExecutor();

  // choice.kind === "engine": a runtime_config id OR a built-in engine id.
  const cfg = runtimeConfigs.find((r) => r.id === choice.engine);
  if (cfg) {
    if (cfg.kind === "claude-code") return new ClaudeCodeExecutor();
    // vllm + openai-compatible both run via the OpenAI-compatible engine path;
    // carry the row's baseUrl/model so a non-default endpoint is honored.
    return new VllmExecutor({ baseUrl: cfg.baseUrl, model: cfg.model });
  }
  // A built-in framework engine id (ai-sdk:anthropic, anthropic, …) → hosted.
  return new RemoteApiExecutor();
}

/**
 * Resolve a node → its concrete {@link RuntimeExecutor} in one call. `ctx`
 * carries the live routing inputs (the orchestrator-runtime marker default +
 * the saved runtime_configs rows). Throws `ConfigError` for an unknown/empty
 * choice (the closed-set contract from executor-choice.ts).
 */
export function executorForNode(
  node: Node,
  ctx: {
    markerRuntime?: string | null;
    runtimeConfigs: readonly RuntimeConfigRow[];
    systemDefault?: string | null;
  },
): RuntimeExecutor {
  const choice = resolveNodeExecutorChoice(node, {
    markerRuntime: ctx.markerRuntime,
    runtimeConfigKeys: ctx.runtimeConfigs.map((r) => r.id),
    systemDefault: ctx.systemDefault,
  });
  return executorForChoice(choice, ctx.runtimeConfigs);
}
