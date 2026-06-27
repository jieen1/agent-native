import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description:
    "List all items in the execution queue, optionally filtered by status. " +
    "Returns full queue rows joined with their work item data, plus aggregate " +
    "stats for queued / running / paused counts. Ordered by priority desc, " +
    "then enqueuedAt asc.",
  schema: z.object({
    status: z.string().optional().describe("Filter by queue status (e.g. queued, running, paused)"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();

    // Build the WHERE clause for the join.
    const whereClause = and(
      ownerScope(schema.workItems),
      args.status ? eq(schema.execQueue.status, args.status) : undefined
    );

    // Fetch all queue items joined with their work items.
    const items = (
      await db
        .select()
        .from(schema.execQueue)
        .where(!!whereClause ? whereClause : undefined)
        .orderBy(
          (t) => [
            (t.priority, "desc"),
            (t.enqueuedAt, "asc"),
          ]
        )
        .limit(500)
    ) as any[];

    // Enrich each row with the work item data.
    const enrichedItems = await Promise.all(
      items.map(async (queueRow) => {
        const workItems = await db
          .select()
          .from(schema.workItems)
          .where(and(eq(schema.workItems.id, queueRow.workItemId), ownerScope(schema.workItems)))
          .limit(1);
        const workItem = workItems[0] ?? null;
        return {
          ...queueRow,
          workItem: workItem,
        };
      })
    );

    // Compute aggregate stats for all items visible to the caller.
    const allItems = (
      await db
        .select()
        .from(schema.execQueue)
        .where(ownerScope(schema.workItems))
        .limit(500)
    ) as any[];

    const stats = {
      queued: allItems.filter((r) => r.status === "queued").length,
      running: allItems.filter((r) => r.status === "running").length,
      paused: allItems.filter((r) => r.status === "paused").length,
    };

    return {
      items: enrichedItems,
      stats,
    };
  },
});
