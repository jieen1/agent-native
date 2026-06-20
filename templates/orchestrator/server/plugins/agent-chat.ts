import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";
import { getOrgContext } from "@agent-native/core/org";
import actionsRegistry from "../../.generated/actions-registry.js";
import { registerOrchestratorRuntime } from "../register-runtime.js";

// Register the vLLM engine + Claude Code harness in the server process so the
// agent chat, engine-status route, and model picker all see them.
registerOrchestratorRuntime();

const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "list-tasks",
  "get-task",
  "list-workflows",
];

export default createAgentChatPlugin({
  appId: "orchestrator",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are the Orchestrator agent.

This app manages tasks and workflows (DAGs of sub-agent steps) and executes them. Users create tasks, attach a workflow, and you run the workflow — delegating each step to a sub-agent (with its own engine/model) or a sibling app over A2A, tracking progress, and delivering the result.

Use actions as the single source of truth (they back chat, UI, HTTP, MCP, A2A, and CLI). Call \`view-screen\` first when the active task or selection matters.

When asked to run or execute a task, follow the \`orchestrating\` skill: read the seeded step runs via \`get-task\`, walk them in dependency order, run each step on its assigned engine/model (or delegate to an \`@app\`), report progress with \`upsert-step-run\`, then deliver via \`update-task\`. Stop if the task becomes cancelled. Never fabricate step output — only report what a real sub-agent produced.

Keep changes small and agent-native: add or update actions, expose useful UI, and keep application state/navigation visible to the agent.`,
});
