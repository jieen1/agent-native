import { defineAction } from "@agent-native/core";
import { and, desc, eq } from "drizzle-orm";
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
    return rows;
  },
});
