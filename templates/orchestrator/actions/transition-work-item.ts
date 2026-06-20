import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { type Resolution } from "../shared/status-schemes.js";
import { applyTransition } from "../server/work-items/transition.js";

// transition-work-item — the SOLE writer of business status / environment /
// blocked / resolution / severity (DESIGN §6.2b). Validates from→to against the
// project's scheme (forward skip-forward / rework / cancel / reopen), derives
// statusCategory, enforces "entering a completed/cancelled stage requires a
// resolution from that stage's resolutionsAt set", clears resolution on reopen,
// requires a duplicate-of link for resolution=duplicate, and APPENDS one
// work_item_status_log row every call. Both the agent (MCP) and the human
// (board drag) call it — same gate, no back door.
export default defineAction({
  description:
    "Move a work item to a new business status (the sole writer of status/environment/blocked/resolution/severity). Validates the transition against the project's per-type scheme: forward skip-forward is allowed; rework/cancel/reopen must be listed edges; entering a completed/cancelled stage requires a resolution; reopen clears resolution; resolution=duplicate requires a duplicate-of link. Appends a status-log row. Pass runId when the move is made during an automation run so the watchdog can reconcile.",
  schema: z.object({
    id: z.string().describe("Work item id"),
    toStatus: z.string().describe("Target stage key in the type's scheme"),
    environment: z
      .string()
      .nullable()
      .optional()
      .describe("dev|SIT|UAT|prod — where a test/release stage runs"),
    resolution: z
      .enum([
        "shipped",
        "cancelled",
        "rejected",
        "duplicate",
        "cannot-reproduce",
        "rolled-back",
        "deferred",
      ])
      .optional()
      .describe("Required when entering a completed/cancelled stage"),
    blocked: z.coerce
      .boolean()
      .optional()
      .describe("Set/clear the blocked overlay flag"),
    blockedReason: z.string().nullable().optional(),
    blockedBy: z
      .string()
      .nullable()
      .optional()
      .describe("Optional link to the blocking item"),
    severity: z.enum(["SEV1", "SEV2", "SEV3", "SEV4"]).nullable().optional(),
    runId: z
      .string()
      .optional()
      .describe(
        "The automation run making this move (for the trail + watchdog)",
      ),
  }),
  run: async (args) => {
    const access = await resolveAccess("work_item", args.id);
    if (!access) throw new Error(`Work item ${args.id} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    const item = access.resource as Record<string, unknown>;

    // The actor is the automation run id when this move is made during a run,
    // else the request user (so the watchdog + audit attribute correctly).
    const actor = args.runId ?? getRequestUserEmail() ?? "unknown";

    // Delegate to the shared §6.2b helper (the single writer + trail + audit).
    // Same validation, statusCategory derivation, resolution enforcement, log
    // row, and audit row the PR-merge webhook reuses.
    const outcome = await applyTransition({
      item,
      actor,
      input: {
        toStatus: args.toStatus,
        environment: args.environment,
        resolution: (args.resolution as Resolution | undefined) ?? null,
        blocked: args.blocked,
        blockedReason: args.blockedReason,
        blockedBy: args.blockedBy,
        severity: args.severity,
        runId: args.runId ?? null,
      },
    });
    return outcome;
  },
});
