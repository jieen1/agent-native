// VllmExecutor — the EXECUTE stage for a node whose brain is the HOST vLLM
// (DESIGN §7.4.1a, §7.4.9). The agent loop runs ON THE HOST (this process):
// `runAgentLoop` is resolved against an `ai-sdk:openai` engine pointed at the
// host vLLM's OpenAI-compatible endpoint (default http://localhost:8000/v1).
// Only the TOOL side effects (bash/read/edit/write) cross into the node's
// microVM, via the VM-bound acting bridge. So the model talks host→vLLM
// (localhost, always reachable) and its tools act in the VM — the VM needs NO
// public egress for a vLLM node.
//
// Model (task #89): node.modelOverride (explicit) → runtime_configs row's own
// model (cfg, when RoutingRuntimeExecutor matched one) → node.model (the
// agent-def's static default, e.g. `qwen3.6`) → DEFAULT_VLLM_MODEL. See
// `resolveModel` below — routing to a real remote provider row must not keep
// requesting a model name that row doesn't serve.
// baseUrl/apiKey come from node env (`OPENAI_BASE_URL`/`OPENAI_API_KEY`) or the
// built-in default — vLLM accepts any non-empty key, so a placeholder is fine.

import { createAISDKEngine } from "@agent-native/core/agent/engine";

import { runEngineLoopInVm } from "./engine-loop.js";
import type {
  RuntimeExecCtx,
  RuntimeExecResult,
  RuntimeExecutor,
} from "./types.js";

/** The host vLLM OpenAI-compatible endpoint default (DESIGN §7.4.9 / P2b env). */
export const DEFAULT_VLLM_BASE_URL = "http://localhost:8000/v1";
/** Default model served by the host vLLM (verified tool-calling, P2b). */
export const DEFAULT_VLLM_MODEL = "qwen3.6";
/**
 * vLLM ignores the API key but the OpenAI SDK requires a non-empty one. This is
 * a deliberately fake placeholder, never a real secret (CLAUDE.md secret rule).
 */
const VLLM_PLACEHOLDER_KEY = "sk-vllm-local";

/** The saved runtime_config row backing this executor (baseUrl/model), if any. */
export interface VllmExecutorConfig {
  baseUrl?: string | null;
  model?: string | null;
  /**
   * The runtime_config row's saved API key (router-resolved via
   * `runtimeApiKeySecretKey`, DESIGN §8.3 item2/#84), for a real remote
   * OpenAI-compatible provider. Local vLLM/LM Studio rows never configure
   * one, so `resolveApiKey` still falls through to the placeholder.
   */
  apiKey?: string | null;
}

/** Resolve the vLLM base URL: node env override → runtime_config row → default. */
function resolveBaseUrl(ctx: RuntimeExecCtx, cfg?: VllmExecutorConfig): string {
  const env = ctx.node.runtime?.env ?? {};
  const fromEnv = env.OPENAI_BASE_URL ?? env.VLLM_BASE_URL;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  if (cfg?.baseUrl && cfg.baseUrl.trim() !== "") return cfg.baseUrl;
  return DEFAULT_VLLM_BASE_URL;
}

/**
 * Resolve the model (task #89 fix). Precedence, most specific first:
 *   1. `node.modelOverride` — an EXPLICIT `model_override` the DAG author set
 *      on this node. A deliberate per-node choice always wins, even when the
 *      node is routed to a `runtime_configs` row (e.g. a user's "aliyun"
 *      remote provider).
 *   2. `cfg.model` — the resolved `runtime_configs` ROW's own configured
 *      model. Only present when `RoutingRuntimeExecutor` actually matched a
 *      row; this is what makes a remote provider actually work, since that
 *      row's baseUrl/key almost never serve the agent-def's static model
 *      name (e.g. `vllm`'s seeded `qwen3.6`).
 *   3. `node.model` — the agent-def's static default model. Used only when
 *      there is NO explicit override AND NO matched row (`cfg` undefined) —
 *      i.e. routing fell through to the default env-var-bound vLLM, exactly
 *      the pre-existing behavior for a user who has never configured a
 *      custom runtime.
 *   4. `DEFAULT_VLLM_MODEL` — last resort.
 */
export function resolveModel(
  ctx: RuntimeExecCtx,
  cfg?: VllmExecutorConfig,
): string {
  const override = ctx.node.modelOverride;
  if (override && override.trim() !== "") return override;
  if (cfg?.model && cfg.model.trim() !== "") return cfg.model;
  const m = ctx.node.model;
  if (m && m.trim() !== "") return m;
  return DEFAULT_VLLM_MODEL;
}

/** Resolve the API key: node env (real secret injected upstream) → runtime_config row → placeholder. */
function resolveApiKey(ctx: RuntimeExecCtx, cfg?: VllmExecutorConfig): string {
  const env = ctx.node.runtime?.env ?? {};
  const k = env.OPENAI_API_KEY ?? env.VLLM_API_KEY;
  if (k && k.trim() !== "") return k;
  if (cfg?.apiKey && cfg.apiKey.trim() !== "") return cfg.apiKey;
  return VLLM_PLACEHOLDER_KEY;
}

export class VllmExecutor implements RuntimeExecutor {
  readonly kind = "vllm";

  /** `cfg` carries the saved runtime_config row's baseUrl/model (router-supplied). */
  constructor(private readonly cfg?: VllmExecutorConfig) {}

  async run(ctx: RuntimeExecCtx): Promise<RuntimeExecResult> {
    const baseUrl = resolveBaseUrl(ctx, this.cfg);
    const model = resolveModel(ctx, this.cfg);
    const apiKey = resolveApiKey(ctx, this.cfg);

    // `ai-sdk:openai` engine with a custom baseUrl → OpenAI chat-completions
    // against the host vLLM (DESIGN §13: createAISDKEngine, baseUrl support).
    // `allowEnvFallback:false` keeps a request-scoped run from leaking the host
    // process env's real OpenAI key into a local vLLM call.
    const engine = createAISDKEngine("openai", {
      apiKey,
      baseUrl,
      model,
      allowEnvFallback: false,
    });

    return runEngineLoopInVm({ ctx, engine, model, kind: this.kind });
  }
}
