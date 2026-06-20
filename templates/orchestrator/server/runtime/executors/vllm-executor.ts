// VllmExecutor — the EXECUTE stage for a node whose brain is the HOST vLLM
// (DESIGN §7.4.1a, §7.4.9). The agent loop runs ON THE HOST (this process):
// `runAgentLoop` is resolved against an `ai-sdk:openai` engine pointed at the
// host vLLM's OpenAI-compatible endpoint (default http://localhost:8000/v1).
// Only the TOOL side effects (bash/read/edit/write) cross into the node's
// microVM, via the VM-bound acting bridge. So the model talks host→vLLM
// (localhost, always reachable) and its tools act in the VM — the VM needs NO
// public egress for a vLLM node.
//
// Model: the node's `model`, defaulting to `qwen3.6` (the host vLLM model).
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
}

/** Resolve the vLLM base URL: node env override → runtime_config row → default. */
function resolveBaseUrl(ctx: RuntimeExecCtx, cfg?: VllmExecutorConfig): string {
  const env = ctx.node.runtime?.env ?? {};
  const fromEnv = env.OPENAI_BASE_URL ?? env.VLLM_BASE_URL;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  if (cfg?.baseUrl && cfg.baseUrl.trim() !== "") return cfg.baseUrl;
  return DEFAULT_VLLM_BASE_URL;
}

/** Resolve the model: node.model → runtime_config row → default vLLM model. */
function resolveModel(ctx: RuntimeExecCtx, cfg?: VllmExecutorConfig): string {
  const m = ctx.node.model;
  if (m && m.trim() !== "") return m;
  if (cfg?.model && cfg.model.trim() !== "") return cfg.model;
  return DEFAULT_VLLM_MODEL;
}

/** Resolve the API key: node env (real secret injected upstream) → placeholder. */
function resolveApiKey(ctx: RuntimeExecCtx): string {
  const env = ctx.node.runtime?.env ?? {};
  const k = env.OPENAI_API_KEY ?? env.VLLM_API_KEY;
  return k && k.trim() !== "" ? k : VLLM_PLACEHOLDER_KEY;
}

export class VllmExecutor implements RuntimeExecutor {
  readonly kind = "vllm";

  /** `cfg` carries the saved runtime_config row's baseUrl/model (router-supplied). */
  constructor(private readonly cfg?: VllmExecutorConfig) {}

  async run(ctx: RuntimeExecCtx): Promise<RuntimeExecResult> {
    const baseUrl = resolveBaseUrl(ctx, this.cfg);
    const model = resolveModel(ctx, this.cfg);
    const apiKey = resolveApiKey(ctx);

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
