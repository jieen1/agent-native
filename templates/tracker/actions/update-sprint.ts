import { defineAction } from "@agent-native/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description: "Update an existing sprint. Only provided fields are changed.",
  schema: z.object({
    id: z.string().min(1).describe("Sprint id"),
    name: z.string().optional().describe("New sprint name"),
    goal: z.string().optional().describe("New sprint goal"),
    status: z.string().optional().describe("New status (规划|进行中|已完成)"),
    branch: z.string().optional().describe("New git branch"),
    startDate: z.string().optional().describe("New start date (ISO-8601)"),
    endDate: z.string().optional().describe("New end date (ISO-8601)"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const db = getDb();

    const existing = (
      await db
        .select()
        .from(schema.sprints)
        .where(and(eq(schema.sprints.id, args.id), ownerScope(schema.sprints)))
        .limit(1)
    )[0];
    if (!existing) throw new Error("Sprint not found or not accessible");

    const values: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (args.name !== undefined) values.name = args.name.trim();
    if (args.goal !== undefined) values.goal = args.goal.trim();
    if (args.status !== undefined) values.status = args.status;
    if (args.branch !== undefined) values.branch = args.branch.trim();
    if (args.startDate !== undefined) values.startDate = args.startDate.trim();
    if (args.endDate !== undefined) values.endDate = args.endDate.trim();

    await db
      .update(schema.sprints)
      .set(values as any)
      .where(eq(schema.sprints.id, args.id));

    const updated = await db
      .select()
      .from(schema.sprints)
      .where(eq(schema.sprints.id, args.id))
      .limit(1);

    const row = updated[0];
    if (!row) throw new Error("Sprint not found after update");

    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      goal: row.goal,
      status: row.status,
      branch: row.branch,
      startDate: row.startDate,
      endDate: row.endDate,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
});
