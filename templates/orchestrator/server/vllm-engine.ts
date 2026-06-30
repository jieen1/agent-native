import {
  registerAgentEngine,
  createAISDKEngine,
} from "@agent-native/core/agent/engine";

/**
 * Local-vLLM chat engine for the orchestrator's in-app (sidebar) agent chat —
 * kept ENTIRELY in this template so `@agent-native/core` stays pristine and
 * upstream merges remain clean. Only calls core's public
 * `registerAgentEngine` / `createAISDKEngine` (never patch core).
 *
 * Why: the orchestrator sidebar chat is the standard AgentChat surface, whose
 * composer is gated by `useAgentEngineConfigured` → `/agent-engine/status`.
 * The built-in `ai-sdk:openai` engine reports pkg=False in a bundled build
 * (its `@ai-sdk/openai` is inlined, not require.resolve-able), so the gate
 * fails and the sidebar composer is disabled. A thin custom engine with no
 * `installPackage` (pkg=True) + `requiredEnvVars: []` (configured=True) fixes
 * the gate, and `getVllmEngine()` returns a concrete instance the plugin pins
 * so runs always hit vLLM. Requires OPENAI_BASE_URL (+ optional OPENAI_API_KEY,
 * VLLM_DEFAULT_MODEL); a no-op without it.
 */
export function getVllmEngine() {
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!baseUrl) return undefined;
  return createAISDKEngine("openai", {
    baseUrl,
    apiKey: process.env.OPENAI_API_KEY || "vllm-local",
    model: process.env.VLLM_DEFAULT_MODEL || "claude-sonnet-4-6",
  });
}

let registered = false;

export function registerVllmEngine(): void {
  if (registered) return;
  registered = true;

  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!baseUrl) return;

  registerAgentEngine({
    name: "vllm",
    label: "本地 vLLM",
    description:
      "Local vLLM via its OpenAI-compatible API (OPENAI_BASE_URL). No external key required.",
    capabilities: {
      thinking: false,
      promptCaching: false,
      vision: false,
      computerUse: false,
      parallelToolCalls: true,
    },
    defaultModel: process.env.VLLM_DEFAULT_MODEL || "claude-sonnet-4-6",
    supportedModels: [
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "qwen3.6",
      "ornith-1.0-35b",
    ],
    requiredEnvVars: [],
    create: (config) =>
      createAISDKEngine("openai", {
        ...config,
        baseUrl,
        apiKey: process.env.OPENAI_API_KEY || "vllm-local",
      }),
  });
}
