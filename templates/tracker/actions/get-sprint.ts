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

    const { inArray } = await import("drizzle-orm");
    const stages =
      items.length > 0
        ? await db
            .select()
            .from(schema.stages)
            .where(inArray(schema.stages.workItemId, items.map((i) => i.id)))
        : [];

    return {
      id: sprint.id,
      projectId: sprint.projectId,
      name: sprint.name,
      goal: sprint.goal,
      status: sprint.status,
      phase: sprint.phase,
      executorThreadId: sprint.executorThreadId,
      branch: sprint.branch,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      createdAt: sprint.createdAt,
      updatedAt: sprint.updatedAt,
      items,
      stages,
      itemCount: items.length,
      delivered: items.filter((i) => i.status === "done").length,
    };
  },
});
