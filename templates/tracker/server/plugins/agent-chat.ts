import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";
import { registerVllmEngine, getVllmEngine } from "../vllm-engine.js";

// Register the local vLLM engine so the composer gate/model picker see it,
// and pin a concrete instance so runs always hit vLLM (same recipe as the
// chat and orchestrator templates). No-op without OPENAI_BASE_URL.
registerVllmEngine();
const vllmEngine = getVllmEngine();

const TRACKER_SYSTEM_PROMPT = `## Tracker

You are the in-app agent for Tracker, a project + work-item tracker that dispatches
work to the Orchestrator's Claude Code brain for autonomous execution.

Core model:
- A **project** holds its repo + default branch, configured ONCE. Every work item
  under it inherits that repo context — work items never carry a repo field.
- A **work item** holds a title + a free-form requirement/intent.
- **Dispatch** sends a work item to the orchestrator brain (over MCP), which
  clones the project repo into a workspace, decomposes the work (CC analyze,
  vLLM develop, CC review), monitors itself, and opens a PR. Dispatch returns a
  brain threadId stored on the item; activity is read back by tag.

Rules:
- Use Tracker actions, not raw database access.
- Use \`create-project\` (set name + git remote + default branch), \`list-projects\`,
  \`create-work-item\` (pick a project, give a requirement — NO repo field),
  \`list-work-items\`, \`get-work-item\`.
- Use \`dispatch-to-orchestrator\` to hand a work item to the brain; it returns a
  threadId. Use \`get-activity\` to read the brain transcript and tagged runs back.
- Use \`view-screen\` when the open project/item or current board view is unclear.
- Use \`navigate\` to open the board, projects, or a specific item.
- Never hardcode secrets or credential-looking literals.
- If a tool fails, say so plainly and pick the next safe action. Never fabricate
  success from an error.`;

const INITIAL_TOOL_NAMES = [
  "view-screen",
  "list-projects",
  "create-project",
  "list-work-items",
  "create-work-item",
  "get-work-item",
  "dispatch-to-orchestrator",
  "get-activity",
  "navigate",
];

export default createAgentChatPlugin({
  appId: "tracker",
  engine: vllmEngine,
  systemPrompt: TRACKER_SYSTEM_PROMPT,
  leanPrompt: true,
  initialToolNames: INITIAL_TOOL_NAMES,
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  nativeActionsInDev: true,
  skipFilesContext: true,
  databaseTools: false,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
});
