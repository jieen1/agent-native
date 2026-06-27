import { defineAction } from "@agent-native/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description: "Get a single sprint with its bound work items.",
  schema: z.object({
    id: z.string().min(1).describe("Sprint id"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const db = getDb();
    const sprint = (
      await db
        .select()
        .from(schema.sprints)
        .where(and(eq(schema.sprints.id, args.id), ownerScope(schema.sprints)))
        .limit(1)
    )[0];
    if (!sprint) throw new Error("Sprint not found or not accessible");

    const items = await db
      .select()
      .from(schema.workItems)
      .where(eq(schema.workItems.sprintId, args.id));

    return {
      id: sprint.id,
      projectId: sprint.projectId,
      name: sprint.name,
      goal: sprint.goal,
      status: sprint.status,
      branch: sprint.branch,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      createdAt: sprint.createdAt,
      updatedAt: sprint.updatedAt,
      items,
      itemCount: items.length,
    };
  },
});
