import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";
import { getOrgContext } from "@agent-native/core/org";
import actionsRegistry from "../../.generated/actions-registry.js";
import { registerVllmEngine, getVllmEngine } from "../vllm-engine.js";

// Register the local-vLLM engine in this process so the engine-status route and
// model picker see it. No-op unless OPENAI_BASE_URL is set. Template-only — core
// is untouched (we only call core's public registerAgentEngine API).
registerVllmEngine();

// Build the concrete engine instance ONCE. Passing an instance (not a name)
// makes resolveEngine return it verbatim — the chat run can never fall through
// to a stale stored setting or the pkg-gated built-in ai-sdk:openai.
const vllmEngine = getVllmEngine();

const INITIAL_TOOL_NAMES = ["view-screen", "navigate", "hello"];

export default createAgentChatPlugin({
  appId: "chat",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  initialToolNames: INITIAL_TOOL_NAMES,
  // When a local vLLM is configured, pin it as the chat engine so the composer
  // is usable out of the box (no per-user key, no "Connect AI") and runs always
  // hit vLLM. Falls back to the framework default (Anthropic) when unset.
  engine: vllmEngine,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are the Chat app agent.

This is a minimal chat-first Agent-Native app. The chat is the product surface, and actions are the contract shared by chat, UI, HTTP, MCP, A2A, and CLI.

Use actions as the source of truth. Start by inspecting the current screen when context matters. When the user asks to extend this app, keep the change small and agent-native: add or update actions, expose useful UI, and keep application state/navigation visible to the agent.`,
});
