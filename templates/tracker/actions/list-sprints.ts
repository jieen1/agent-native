import { defineAction } from "@agent-native/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description: "List sprints, optionally filtered to one project or status.",
  schema: z.object({
    projectId: z.string().optional().describe("Filter to a single project"),
    status: z.string().optional().describe("Filter by status (规划|进行中|已完成)"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const db = getDb();
    const where = and(
      ownerScope(schema.sprints),
      args.projectId ? eq(schema.sprints.projectId, args.projectId) : undefined,
      args.status ? eq(schema.sprints.status, args.status) : undefined,
    );
    const rows = await db
      .select({
        id: schema.sprints.id,
        projectId: schema.sprints.projectId,
        name: schema.sprints.name,
        goal: schema.sprints.goal,
        status: schema.sprints.status,
        branch: schema.sprints.branch,
        startDate: schema.sprints.startDate,
        endDate: schema.sprints.endDate,
        createdAt: schema.sprints.createdAt,
        updatedAt: schema.sprints.updatedAt,
      })
      .from(schema.sprints)
      .where(where)
      .orderBy(desc(schema.sprints.createdAt));

    if (rows.length === 0) return rows;

    // Attach item counts per sprint in one query.
    const sprintIds = rows.map((r) => r.id);
    const counts = await db
      .select({
        sprintId: schema.workItems.sprintId,
        itemCount: sql<number>`count(*)::int`,
        delivered: sql<number>`count(*) filter (where ${schema.workItems.status} = 'done')::int`,
      })
      .from(schema.workItems)
      .where(
        and(
          sql`${schema.workItems.sprintId} = any(array[${sql.join(sprintIds.map((id) => sql`${id}`), sql`, `)}])`,
        ),
      )
      .groupBy(schema.workItems.sprintId);

    const countMap = new Map(counts.map((c) => [c.sprintId, c]));
    return rows.map((r) => ({
      ...r,
      itemCount: countMap.get(r.id)?.itemCount ?? 0,
      delivered: countMap.get(r.id)?.delivered ?? 0,
    }));
  },
});
