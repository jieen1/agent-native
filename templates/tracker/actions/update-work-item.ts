import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description: "Update mutable fields on a work item (metadata, not status transitions).",
  schema: z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    priority: z.number().int().optional(),
    risk: z.string().optional(),
    tags: z.array(z.string()).optional(),
    executionMode: z.string().optional(),
    sprintId: z.string().nullable().optional(),
    plannedStages: z.array(z.string()).optional(),
    currentStageName: z.string().optional(),
    branch: z.string().nullable().optional(),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const existing = (
      await db
        .select()
        .from(schema.workItems)
        .where(and(eq(schema.workItems.id, args.id), ownerScope(schema.workItems)))
        .limit(1)
    )[0];
    if (!existing) throw new Error("Work item not found");

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { updatedAt: now };

    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.type !== undefined) patch.type = args.type;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.risk !== undefined) patch.risk = args.risk;
    if (args.tags !== undefined) patch.tags = JSON.stringify(args.tags);
    if (args.executionMode !== undefined) patch.executionMode = args.executionMode;
    if (args.sprintId !== undefined) patch.sprintId = args.sprintId;
    if (args.plannedStages !== undefined) patch.plannedStages = JSON.stringify(args.plannedStages);
    if (args.currentStageName !== undefined) patch.currentStageName = args.currentStageName;
    if (args.branch !== undefined) patch.branch = args.branch;

    await db
      .update(schema.workItems)
      .set(patch as Parameters<typeof db.update>[0] extends infer T ? any : never)
      .where(and(eq(schema.workItems.id, args.id), ownerScope(schema.workItems)));

    const updated = (
      await db
        .select()
        .from(schema.workItems)
        .where(eq(schema.workItems.id, args.id))
        .limit(1)
    )[0];

    return updated;
  },
});
