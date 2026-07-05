import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";
import { getOrgContext } from "@agent-native/core/org";
import actionsRegistry from "../../.generated/actions-registry.js";
import { registerOrchestratorRuntime } from "../register-runtime.js";
import { registerVllmEngine, getVllmEngine } from "../vllm-engine.js";

// Register the vLLM engine + Claude Code harness in the server process so the
// agent chat, engine-status route, and model picker all see them.
registerOrchestratorRuntime();
registerVllmEngine();

// Concrete vLLM engine instance pinned for the sidebar chat run (highest
// resolveEngine priority) so it never falls through to the pkg-gated built-in.
const vllmEngine = getVllmEngine();

const INITIAL_TOOL_NAMES = ["view-screen", "navigate"];

export default createAgentChatPlugin({
  appId: "orchestrator",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  initialToolNames: INITIAL_TOOL_NAMES,
  // SECURITY: do NOT expose the raw DB tools (db-query/db-exec/db-patch/db-schema)
  // on the agent + MCP/A2A surface. The framework default is "write", but this
  // app's MCP catalog is reached by the brain and any A2A/MCP caller holding the
  // shared A2A_SECRET, so raw SQL here bypasses per-owner accessFilter and the
  // audit log entirely. The brain drives work through scoped actions (runsList,
  // workflowRun, ...) and never needs raw SQL. Matches tracker/forms.
  databaseTools: false,
  // Pin local vLLM as the sidebar chat engine when configured (composer usable,
  // runs always hit vLLM). Falls back to the framework default when unset.
  engine: vllmEngine,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are the Orchestrator agent.

This app runs agent workflows as DAGs of sub-agent steps, executed by the orchestrator brain across configured runtimes (vLLM, Claude Code, microVMs).

Use actions as the single source of truth (they back chat, UI, HTTP, MCP, A2A, and CLI). Call \`view-screen\` first when the active run or selection matters.

Keep changes small and agent-native: add or update actions, expose useful UI, and keep application state/navigation visible to the agent.`,
});
