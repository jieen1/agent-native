import { defineAction } from "@agent-native/core";
import { accessFilter } from "@agent-native/core/sharing";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description: "List tasks, newest first. Optionally filter by status.",
  schema: z.object({
    status: z
      .enum(["pending", "running", "done", "failed", "cancelled"])
      .optional(),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const db = getDb();
    const rows = await db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        description: schema.tasks.description,
        status: schema.tasks.status,
        workflowId: schema.tasks.workflowId,
        createdAt: schema.tasks.createdAt,
        updatedAt: schema.tasks.updatedAt,
      })
      .from(schema.tasks)
      .where(
        and(
          accessFilter(schema.tasks, schema.taskShares),
          isNull(schema.tasks.deletedAt),
          args.status ? eq(schema.tasks.status, args.status) : undefined,
        ),
      )
      .orderBy(desc(schema.tasks.updatedAt));

    return rows;
  },
});
