import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

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
    const userEmail = getRequestUserEmail();
    if (!userEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();

    const db = getDb();

    // Inline owner filter directly on exec_queue columns — avoids any
    // cross-table column reference that ownerScope() can produce.
    function queueOwnerFilter() {
      const clauses = [eq(schema.execQueue.ownerEmail, userEmail!)];
      if (orgId) clauses.push(eq(schema.execQueue.orgId, orgId));
      return clauses.length === 1 ? clauses[0]! : or(...clauses)!;
    }

    const whereClause = and(
      queueOwnerFilter(),
      args.status ? eq(schema.execQueue.status, args.status) : undefined,
    );

    const items = (
      await db
        .select()
        .from(schema.execQueue)
        .where(whereClause)
        .orderBy(desc(schema.execQueue.priority), asc(schema.execQueue.enqueuedAt))
        .limit(500)
    ) as any[];

    // Enrich each row with the work item data.
    const enrichedItems = await Promise.all(
      items.map(async (queueRow) => {
        const workItems = await db
          .select()
          .from(schema.workItems)
          .where(and(
            eq(schema.workItems.id, queueRow.workItemId),
            eq(schema.workItems.ownerEmail, userEmail!),
          ))
          .limit(1);
        return { ...queueRow, workItem: workItems[0] ?? null };
      }),
    );

    // Aggregate stats for all queue items visible to the caller.
    const allItems = (
      await db
        .select()
        .from(schema.execQueue)
        .where(queueOwnerFilter())
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
