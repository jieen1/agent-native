// A2A inbound surface — makes the orchestrator reachable by sibling
// agent-native apps (e.g. `tracker`) over the Agent-to-Agent JSON-RPC protocol
// (v3-DESIGN §16: "Orchestrator exposes its MCP surface ALSO via A2A. Any
// agent-native app in the same workspace can call orchestrator actions").
//
// HOW THIS LAYERS WITH THE AUTO-MOUNT
// -----------------------------------
// `createAgentChatPlugin` (server/plugins/agent-chat.ts) already auto-mounts a
// generic A2A surface — the JSON-RPC endpoint at `/_agent-native/a2a`, the
// agent card at `/.well-known/agent-card.json`, and the agent-loop handler that
// reaches EVERY action (`brain-send`, `workflowRun`, `workspaceCreate`,
// `runsList`, …) as a tool, scoped to the A2A-JWT-verified caller. The handler,
// auth (A2A_SECRET / `sub`=email — same path MCP uses), task store, and
// streaming all come from the framework; we do not re-implement them.
//
// What the auto-mounted card lacks is a useful DISCOVERY advertisement: it
// derives a generic name and only lists actions that declare
// `publicAgent: { expose, readOnly }`. This plugin mounts the authoritative
// orchestrator card so peers can discover the dispatch + read-back surface they
// need. It is registered from `server/plugins/a2a.ts`, which sorts BEFORE
// `agent-chat.ts`; both register their routes after the SAME shared bootstrap
// promise resolves, so this plugin's continuation is queued first and its card
// handler (which returns and terminates dispatch) wins the route. A sentinel
// keeps the mount idempotent across HMR / repeated plugin invocation.
//
// Peers still send NATURAL-LANGUAGE messages over A2A (the handler is the
// agent loop, not a structured action RPC): e.g. dispatch with
//   "Run workflowRun for template <id> with inputs <…> and tags
//    {source:'tracker', item_id:'PAY-14'}"
// and read back with
//   "Call runsList with tagMatch {source:'tracker', item_id:'PAY-14'}".
// The orchestrator agent then invokes the corresponding action as a tool,
// scoped to the caller's verified identity.

import {
  getH3App,
  markDefaultPluginProvided,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";
import { mountA2A } from "@agent-native/core/a2a";
import type { AgentSkill } from "@agent-native/core/a2a";
import actionsRegistry from "../../.generated/actions-registry.js";

const A2A_MOUNTED = Symbol.for("orchestrator.a2a.mounted");

/**
 * Curated A2A skills advertised on the orchestrator agent card. These name the
 * exact actions a dispatching peer (tracker) calls — the dispatch targets and
 * the tag-match read-back surface from v3-DESIGN §16. Descriptions are pulled
 * from the live action registry so the card never drifts from the real tools.
 */
function buildOrchestratorSkills(
  actions: Record<string, { tool?: { description?: string } }>,
): AgentSkill[] {
  const advertised: Array<{
    id: string;
    name: string;
    tags: string[];
    examples: string[];
    readOnly: boolean;
  }> = [
    {
      id: "brain-send",
      name: "Dispatch a task to the orchestrator brain",
      tags: ["dispatch", "orchestrate"],
      examples: [
        "Send a task to the orchestrator brain to fix the failing payments test in repo acme/api.",
      ],
      readOnly: false,
    },
    {
      id: "workflowRun",
      name: "Run a workflow DAG",
      tags: ["dispatch", "workflow"],
      examples: [
        "Run workflowRun for template tmpl_x with inputs {…} and tags {source:'tracker', item_id:'PAY-14'}.",
      ],
      readOnly: false,
    },
    {
      id: "workspaceCreate",
      name: "Create an isolated workspace",
      tags: ["dispatch", "workspace"],
      examples: [
        "Create a workspace for repo acme/api on branch main, tags {source:'tracker', item_id:'PAY-14'}.",
      ],
      readOnly: false,
    },
    {
      id: "runsList",
      name: "List runs (tag-match read-back)",
      tags: ["read", "observe"],
      examples: [
        "Call runsList with tagMatch {source:'tracker', item_id:'PAY-14'}.",
      ],
      readOnly: true,
    },
    {
      id: "spawnList",
      name: "List spawns (tag-match read-back)",
      tags: ["read", "observe"],
      examples: [
        "Call spawnList with tagMatch {source:'tracker', item_id:'PAY-14'}.",
      ],
      readOnly: true,
    },
    {
      id: "workspaceList",
      name: "List workspaces (tag-match read-back)",
      tags: ["read", "observe"],
      examples: [
        "Call workspaceList with tagMatch {source:'tracker', item_id:'PAY-14'}.",
      ],
      readOnly: true,
    },
  ];

  return advertised
    .filter((s) => actions[s.id])
    .map((s) => ({
      id: s.id,
      name: s.name,
      description:
        actions[s.id]?.tool?.description ?? `Orchestrator action ${s.id}.`,
      tags: s.tags,
      examples: s.examples,
      readOnly: s.readOnly,
    }));
}

export default async function orchestratorA2APlugin(
  nitroApp: any,
): Promise<void> {
  // Tell the framework an `a2a` slot is app-provided (kept for parity with how
  // other default-plugin slots signal themselves; the A2A auto-mount lives
  // inside createAgentChatPlugin and is harmless to co-exist with — our card
  // registers first and wins, our JSON-RPC handler is an inert duplicate).
  markDefaultPluginProvided(nitroApp, "a2a");

  if (nitroApp[A2A_MOUNTED]) return;
  nitroApp[A2A_MOUNTED] = true;

  // Touch the H3 app so the framework readiness gate holds /_agent-native
  // requests until routes are registered, mirroring the auto-mount.
  getH3App(nitroApp);

  const actions = loadActionsFromStaticRegistry(
    actionsRegistry as Record<string, unknown>,
  ) as Record<string, { tool?: { description?: string } }>;

  // Authoritative orchestrator agent card. Auth is the shared A2A_SECRET JWT
  // (sub = caller email) handled entirely by the framework — same path the MCP
  // surface uses. `publicSkillsOnly: false` keeps our curated skills list
  // (which intentionally includes write dispatch actions) intact for discovery;
  // actual invocation is always gated by the JWT-verified handler.
  mountA2A(nitroApp, {
    name: "Orchestrator",
    description:
      "Multi-model workflow execution engine. Sibling apps dispatch tasks via " +
      "brain-send / workflowRun / workspaceCreate (pass opaque `tags`), then " +
      "read back activity with runsList / spawnList / workspaceList using " +
      "`tagMatch` (v3-DESIGN §16).",
    version: "1.0.0",
    streaming: true,
    publicSkillsOnly: false,
    skills: buildOrchestratorSkills(actions),
  });

  console.log(
    "[orchestrator] A2A mounted — card /.well-known/agent-card.json, " +
      "JSON-RPC /_agent-native/a2a (JWT via A2A_SECRET, sub=email).",
  );
}
