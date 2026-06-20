import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// Hard-delete a work item and its dependent rows (links + status log). Unlike
// templates (which keep runs loadable via soft delete), a work item has no
// observation requirement once removed; its links/log are meaningless without
// it. Owner-scoped.
export default defineAction({
  description:
    "Delete a work item and its links + status-log rows. Owner-scoped.",
  schema: z.object({ id: z.string() }),
  run: async (args) => {
    const access = await resolveAccess("work_item", args.id);
    if (!access) throw new Error(`Work item ${args.id} not found`);
    if (access.role !== "owner" && access.role !== "admin") {
      throw new Error("Only the owner can delete a work item");
    }
    const db = getDb();
    await db
      .delete(schema.workItemStatusLog)
      .where(eq(schema.workItemStatusLog.workItemId, args.id));
    await db
      .delete(schema.workItemLinks)
      .where(eq(schema.workItemLinks.fromItem, args.id));
    await db
      .delete(schema.workItemLinks)
      .where(eq(schema.workItemLinks.toItem, args.id));
    await db.delete(schema.workItems).where(eq(schema.workItems.id, args.id));
    return { id: args.id, ok: true };
  },
});
