import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { nowIso } from "./_util.js";

// Patch-style work-item update for EVERYTHING EXCEPT the business-status
// dimensions. Per DESIGN §6.2b the single writer of status / environment /
// blocked / resolution / severity is `transition-work-item`; this action
// REJECTS those fields so there is no back door (the §0.2.5 invariant).
const REJECTED_FIELDS = [
  "status",
  "statusCategory",
  "environment",
  "blocked",
  "blockedReason",
  "blockedBy",
  "resolution",
  "severity",
] as const;

export default defineAction({
  description:
    "Update a work item's non-status fields (title, description, priority, assignee, type, workflowId, workflowRunId, deliverable). REJECTS any business-status field (status/environment/blocked/resolution/severity) — those go ONLY through transition-work-item.",
  // `.passthrough()` so a caller that wrongly includes a rejected field reaches
  // our explicit guard with a clear message instead of zod silently stripping it.
  schema: z
    .object({
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.coerce.number().int().optional(),
      assignee: z.string().nullable().optional(),
      type: z.enum(["requirement", "bug", "prod-issue", "task"]).optional(),
      workflowId: z.string().nullable().optional(),
      workflowRunId: z.string().nullable().optional(),
      deliverable: z
        .object({ kind: z.string(), ref: z.unknown() })
        .nullable()
        .optional(),
    })
    .passthrough(),
  run: async (args) => {
    // Reject business-status fields up front — they are transition-only.
    for (const field of REJECTED_FIELDS) {
      if ((args as Record<string, unknown>)[field] !== undefined) {
        throw new Error(
          `Field '${field}' cannot be set via update-work-item; use transition-work-item (the sole writer of business status).`,
        );
      }
    }

    const access = await resolveAccess("work_item", args.id);
    if (!access) throw new Error(`Work item ${args.id} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");

    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.assignee !== undefined) patch.assignee = args.assignee;
    if (args.type !== undefined) patch.type = args.type;
    if (args.workflowId !== undefined) patch.workflowId = args.workflowId;
    if (args.workflowRunId !== undefined)
      patch.workflowRunId = args.workflowRunId;
    if (args.deliverable !== undefined) {
      patch.deliverable = args.deliverable
        ? JSON.stringify(args.deliverable)
        : null;
    }

    const db = getDb();
    await db
      .update(schema.workItems)
      .set(patch)
      .where(eq(schema.workItems.id, args.id));
    return { id: args.id, ok: true };
  },
});
