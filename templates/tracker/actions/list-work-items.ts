import { defineAction } from "@agent-native/core";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description: "List work items, optionally filtered to one project or status.",
  schema: z.object({
    projectId: z.string().optional().describe("Filter to a single project"),
    status: z.string().optional().describe("Filter by status (open|dispatched|done)"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const db = getDb();
    const where = and(
      ownerScope(schema.workItems),
      args.projectId ? eq(schema.workItems.projectId, args.projectId) : undefined,
      args.status ? eq(schema.workItems.status, args.status) : undefined,
    );
    const rows = await db
      .select({
        id: schema.workItems.id,
        projectId: schema.workItems.projectId,
        type: schema.workItems.type,
        title: schema.workItems.title,
        description: schema.workItems.description,
        status: schema.workItems.status,
        priority: schema.workItems.priority,
        orchestratorThreadId: schema.workItems.orchestratorThreadId,
        dispatchedAt: schema.workItems.dispatchedAt,
        createdAt: schema.workItems.createdAt,
        updatedAt: schema.workItems.updatedAt,
      })
      .from(schema.workItems)
      .where(where)
      .orderBy(desc(schema.workItems.updatedAt));
    return rows;
  },
});
