import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { resolveAccess } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";
import { schemeForType } from "../server/work-items/schemes.js";
import {
  evaluateTransition,
  type Resolution,
} from "../shared/status-schemes.js";

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

    const db = getDb();

    // Load the project's scheme for this item's type.
    const projRows = await db
      .select({ statusSchemes: schema.projects.statusSchemes })
      .from(schema.projects)
      .where(eq(schema.projects.id, String(item.projectId)))
      .limit(1);
    if (projRows.length === 0) {
      throw new Error(`Project ${item.projectId} not found`);
    }
    const scheme = schemeForType(projRows[0].statusSchemes, String(item.type));

    const fromStatus = String(item.status ?? "");

    // For a duplicate resolution we must confirm a duplicate-of link exists FROM
    // this item, BEFORE validating (the validator only needs the boolean).
    let hasDuplicateLink = false;
    if (args.resolution === "duplicate") {
      const dup = await db
        .select({ id: schema.workItemLinks.id })
        .from(schema.workItemLinks)
        .where(
          and(
            eq(schema.workItemLinks.fromItem, args.id),
            eq(schema.workItemLinks.kind, "duplicate-of"),
          ),
        )
        .limit(1);
      hasDuplicateLink = dup.length > 0;
    }

    const decision = evaluateTransition(scheme, fromStatus, args.toStatus, {
      resolution: (args.resolution as Resolution | undefined) ?? null,
      hasDuplicateLink,
    });
    if (!decision.ok) {
      throw new Error(`Illegal transition: ${decision.error}`);
    }

    const now = nowIso();
    const actor = args.runId ?? getRequestUserEmail() ?? "unknown";

    // Build the patch. status/statusCategory/resolution come from the validated
    // decision; environment/blocked/severity are overlays this writer also owns.
    const patch: Record<string, unknown> = {
      status: decision.toStatus,
      statusCategory: decision.statusCategory,
      resolution: decision.resolution,
      updatedAt: now,
    };
    if (args.environment !== undefined) patch.environment = args.environment;
    if (args.severity !== undefined) patch.severity = args.severity;
    if (args.blocked !== undefined) {
      patch.blocked = args.blocked ? 1 : 0;
      // Clearing blocked clears its reason/link unless a new one is given.
      if (!args.blocked) {
        patch.blockedReason = args.blockedReason ?? null;
        patch.blockedBy = args.blockedBy ?? null;
      }
    }
    if (args.blockedReason !== undefined)
      patch.blockedReason = args.blockedReason;
    if (args.blockedBy !== undefined) patch.blockedBy = args.blockedBy;

    await db
      .update(schema.workItems)
      .set(patch)
      .where(eq(schema.workItems.id, args.id));

    // Append the trail row (DESIGN §6.2b) — one per call, always.
    await db.insert(schema.workItemStatusLog).values({
      id: newId("wisl"),
      workItemId: args.id,
      runId: args.runId ?? null,
      actor,
      fromStatus,
      toStatus: decision.toStatus,
      blocked: args.blocked ? 1 : 0,
      resolution: decision.resolution,
      at: now,
    });

    return {
      id: args.id,
      from: fromStatus,
      to: decision.toStatus,
      kind: decision.kind,
      statusCategory: decision.statusCategory,
      resolution: decision.resolution,
    };
  },
});
