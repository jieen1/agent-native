import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description:
    "Permanently delete a work item and all its associated data " +
    "(stages, comments, links, activities, artifacts).",
  schema: z.object({
    id: z.string().min(1).describe("Work item id to delete"),
  }),
  http: { method: "DELETE" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();

    // Verify ownership before deleting
    const [item] = await db
      .select({ id: schema.workItems.id, itemKey: schema.workItems.itemKey })
      .from(schema.workItems)
      .where(
        and(eq(schema.workItems.id, args.id), ownerScope(schema.workItems)),
      )
      .limit(1);

    if (!item) throw new Error("Work item not found or access denied");

    // Delete associated data first (foreign key order)
    await db
      .delete(schema.activities)
      .where(eq(schema.activities.workItemId, args.id));

    await db
      .delete(schema.comments)
      .where(eq(schema.comments.workItemId, args.id));

    await db.delete(schema.links).where(eq(schema.links.fromItemId, args.id));

    await db.delete(schema.links).where(eq(schema.links.toItemId, args.id));

    await db.delete(schema.stages).where(eq(schema.stages.workItemId, args.id));

    await db
      .delete(schema.artifacts)
      .where(eq(schema.artifacts.workItemId, args.id));

    // Delete the work item itself
    await db
      .delete(schema.workItems)
      .where(
        and(eq(schema.workItems.id, args.id), ownerScope(schema.workItems)),
      );

    return { ok: true, id: args.id, itemKey: item.itemKey };
  },
});
