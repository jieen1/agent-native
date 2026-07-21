import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

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

// Curated MCP tool surface for the orchestrator brain (and any other MCP
// caller that doesn't opt into `catalog_scope: "full"`) — see
// `server/brain/brain-mcp-config.ts`'s `mintBrainToken`. Without this the MCP
// endpoint serves its full ~187-tool catalog to every caller, which (a) is
// architecturally the wrong default per `connectorCatalog`'s own design
// intent (packages/core/src/mcp/build-server.ts), and (b) is what caused a
// real production failure: a stricter function-calling schema validator on an
// Aliyun OpenAI-compatible endpoint rejected one of the 187 tools' JSON schema
// (`list_apps`), killing the entire brain turn.
//
// This list is the brain's REAL, evidenced tool surface — cross-checked
// against `server/brain/brain-prompt.ts`'s "# Your tools" section and every
// literal `mcp__orchestrator__<name>` reference in `server/brain/*.ts` and
// `server/engine/v3-reconciler.ts` (the wake-message builders that name tools
// directly), not just the `orchestrating-v3` skill prose. Keep it in sync
// with `brain-prompt.ts` when the brain's tool set changes — an omitted name
// here is not just hidden from `tools/list`, it becomes fully uncallable
// ("Unknown tool") even if the brain's own prompt tells it to call it.
// `tool-search` / `list_apps` / `ask_app` / `open_app` need no entry here —
// `COMPACT_MCP_APP_CATALOG_BUILTINS` always includes them.
const ORCHESTRATOR_BRAIN_CONNECTOR_CATALOG = [
  // Navigation/context (also the sidebar chat's INITIAL_TOOL_NAMES above).
  "navigate",
  "view-screen",
  // Author + run a DAG.
  "workflowRun",
  "workflowList",
  "workflowSave",
  "workflowPatch",
  // One-shot / iterate.
  "spawnOnce",
  "runFork",
  // Monitor (poll — the engine never pushes).
  "runState",
  "v3RunEvents",
  "v3RunNodes",
  "runSummary",
  "nodeSummary",
  // Intervene (SDLC-066: brain-monitor.ts's PERIODIC_CHECK_MESSAGE and
  // v3-reconciler.ts's node-event wake message both literally tell the brain
  // to "用 workflowPatch/nodeRetry/runCancel 介入" on a stuck/drifted run —
  // these two were real actions the brain kept calling per that instruction,
  // but were missing here, so every attempt came back "Unknown tool").
  "nodeRetry",
  "runCancel",
  "spawnCancel",
  // Inspect.
  "runsList",
  "workspaceList",
  "workspaceDiff",
  "workspaceFiles",
  "workspaceRead",
  // Review verdict (the run-level evidence trail).
  "runVerdict",
  // Deliver.
  "workspaceCreate",
  "workspaceCommitPush",
  "workspaceCommit",
  "workspaceCiWatch",
  "workspaceMergePr",
  // Independent pre-merge review gate (mergeReviewOverride stays
  // agentTool:false / human-only — never add it here).
  "mergeReviewStart",
  "mergeReviewGet",
];

export default createAgentChatPlugin({
  appId: "orchestrator",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  initialToolNames: INITIAL_TOOL_NAMES,
  connectorCatalog: ORCHESTRATOR_BRAIN_CONNECTOR_CATALOG,
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
