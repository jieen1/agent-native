import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { z } from "zod";
import { callOrchestratorTool } from "../server/lib/orchestrator-client.js";
import type { OrchestratorWorkflowSummary } from "../shared/types.js";

// Lists the orchestrator's V3 workflow templates (via the same MCP
// tools/call transport dispatch-to-orchestrator.ts uses) so the Stage
// Configuration UI's per-stage dispatch-template picker can offer real
// template names instead of free text. Best-effort: if the orchestrator is
// unreachable or A2A_SECRET isn't configured, returns an empty list rather
// than throwing — this is a read for a dropdown, not a dispatch, and the UI
// falls back to a free-text input when the list is empty.
export default defineAction({
  description:
    "List the orchestrator's available V3 workflow templates, to populate " +
    "the stage-flow dispatch-template picker. Returns an empty array (not an " +
    "error) if the orchestrator can't be reached.",
  schema: z.object({}),
  readOnly: true,
  http: { method: "GET" },
  run: async (): Promise<OrchestratorWorkflowSummary[]> => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    try {
      const { data } = await callOrchestratorTool(
        ownerEmail,
        "workflowList",
        {},
      );
      const rows = Array.isArray(data) ? data : [];
      return rows
        .map((r: any) => ({
          id: String(r?.id ?? r?.name ?? ""),
          name: String(r?.name ?? r?.id ?? ""),
        }))
        .filter((r) => r.id);
    } catch {
      return [];
    }
  },
});
