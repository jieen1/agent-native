import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { resolveActorKind, resolveActorName } from "../server/lib/activity.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export default defineAction({
  description:
    "Enqueue a work item into the execution queue. The item's execution mode " +
    "switches to auto and its status becomes queued. A '触发' activity record " +
    "is appended so the audit trail reflects the admission.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item id to enqueue"),
    priority: z.coerce.number().int().optional().describe("Queue priority (default 0)"),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
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
        .where(and(eq(schema.workItems.id, args.workItemId), ownerScope(schema.workItems)))
        .limit(1)
    )[0];
    if (!workItem) throw new Error("Work item not found or not accessible");

    // Upsert the exec_queue row (INSERT OR REPLACE semantics).
    await db
      .insert(schema.execQueue)
      .values({
        id: nanoid(),
        workItemId: args.workItemId,
        priority: args.priority ?? 0,
        status: "queued",
        currentStage: workItem.currentStageName ?? "",
        enqueuedAt: now,
        startedAt: null,
        ownerEmail,
        orgId,
      })
      .onConflictDoUpdate({
        target: schema.execQueue.workItemId,
        set: {
          priority: args.priority ?? 0,
          status: "queued",
          currentStage: workItem.currentStageName ?? "",
          enqueuedAt: now,
          startedAt: null,
        },
      });

    // Update the work item: switch to auto execution and queued status.
    await db
      .update(schema.workItems)
      .set({
        executionMode: "auto",
        status: "queued",
        updatedAt: now,
      })
      .where(eq(schema.workItems.id, args.workItemId));

    // Append a '触发' activity record.
    const actorKind = resolveActorKind(ctx);
    await db.insert(schema.activities).values({
      id: nanoid(),
      workItemId: args.workItemId,
      actorKind,
      actorName: resolveActorName(actorKind, ownerEmail),
      eventType: "触发",
      payload: JSON.stringify({ mode: "auto" }),
      createdAt: now,
      ownerEmail,
      orgId,
    });

    // Return the queue row.
    const queueRow = (
      await db
        .select()
        .from(schema.execQueue)
        .where(eq(schema.execQueue.workItemId, args.workItemId))
        .limit(1)
    )[0];
    return queueRow;
  },
});
