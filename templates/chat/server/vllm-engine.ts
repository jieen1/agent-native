import {
  registerAgentEngine,
  createAISDKEngine,
} from "@agent-native/core/agent/engine";

/**
 * Local-vLLM chat engine — kept ENTIRELY in this template so `@agent-native/core`
 * stays pristine and upstream merges remain clean. Uses only core's public
 * `registerAgentEngine` / `createAISDKEngine` APIs (call them, never patch core).
 *
 * Why a thin custom engine instead of the built-in `ai-sdk:openai`:
 *  - In a packaged (Nitro) server build, `@ai-sdk/openai` is INLINED into the
 *    bundle and is not resolvable by `require.resolve`. Core's
 *    `isAgentEnginePackageInstalled` therefore reports the built-in engine as
 *    pkg=False, and the chat hides it → "Connect AI" + a disabled composer.
 *    A custom entry with NO `installPackage` skips that resolve check (pkg=True).
 *  - `requiredEnvVars: []` skips the per-user / deploy-credential gate that, in
 *    workspace mode, otherwise forces every signed-in user to paste their own
 *    key. The vLLM key is a non-secret placeholder baked from env here.
 *  The engine itself is still the framework's AI SDK OpenAI engine, just pointed
 *  at the local vLLM endpoint — same approach the orchestrator documents for its
 *  own runtime, no second registry.
 *
 * Requires: the chat template to depend on `@ai-sdk/openai` + `ai` (so the
 * bundler includes them) and `OPENAI_BASE_URL` (+ optional `OPENAI_API_KEY`,
 * `VLLM_DEFAULT_MODEL`) in the env. With no `OPENAI_BASE_URL` set this is a
 * no-op, so a default chat deploy is unaffected.
 */
/**
 * A ready-to-use vLLM engine INSTANCE for the agent-chat plugin's `engine`
 * option. Passing a concrete instance hits `resolveEngine`'s highest-priority
 * branch (returned as-is), so the chat run ALWAYS uses vLLM and can never fall
 * through to a stale stored `agent-engine` setting or the pkg-gated built-in
 * `ai-sdk:openai` (which is pkg=False in a bundled build and resolves
 * unreliably). Returns undefined when no local vLLM is configured.
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
  if (!baseUrl) return; // No local vLLM configured — leave the engine list as-is.

  registerAgentEngine({
    name: "vllm",
    label: "本地 vLLM",
    description:
      "Local vLLM via its OpenAI-compatible API (OPENAI_BASE_URL). No external key required.",
    // No installPackage on purpose: the AI SDK OpenAI provider is inlined into
    // the bundle, so there is nothing for require.resolve to find.
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
    // Empty so isStoredEngineUsableForRequest short-circuits to "configured":
    // the credential is baked from env in create() below, not per user.
    requiredEnvVars: [],
    create: (config) =>
      createAISDKEngine("openai", {
        ...config,
        baseUrl,
        apiKey: process.env.OPENAI_API_KEY || "vllm-local",
      }),
  });
}
