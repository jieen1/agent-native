import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description:
    "Remove a work item from the execution queue. Sets execution mode back to " +
    "manual and status to open (only when the item is currently queued). A " +
    "'状态变更' activity record is appended.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item id to dequeue"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    const now = new Date().toISOString();

    // Confirm the work item exists and is visible to the caller.
    const workItem = (
      await db
        .select()
        .from(schema.workItems)
        .where(
          and(
            eq(schema.workItems.id, args.workItemId),
            ownerScope(schema.workItems),
          ),
        )
        .limit(1)
    )[0];
    if (!workItem) throw new Error("Work item not found or not accessible");

    // Only dequeue if the work item is currently queued.
    const isQueued = workItem.status === "queued";
    if (isQueued) {
      // Remove from exec_queue.
      await db
        .delete(schema.execQueue)
        .where(eq(schema.execQueue.workItemId, args.workItemId));

      // Update work item status.
      await db
        .update(schema.workItems)
        .set({
          executionMode: "manual",
          status: "open",
          updatedAt: now,
        })
        .where(eq(schema.workItems.id, args.workItemId));
    }

    // Append a '状态变更' activity record.
    await db.insert(schema.activities).values({
      id: args.workItemId + "-" + Date.now(),
      workItemId: args.workItemId,
      actorKind: "agent",
      actorName: "智能体",
      eventType: "状态变更",
      payload: JSON.stringify({ action: "dequeued" }),
      createdAt: now,
      ownerEmail,
      orgId,
    });

    return {
      workItemId: args.workItemId,
      removed: isQueued,
    };
  },
});
