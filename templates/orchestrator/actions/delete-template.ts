import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { nowIso } from "./_util.js";

// Delete a v2 workflow template (DESIGN §10). SOFT delete, matching the v1
// `delete-workflow` pattern: set `deleted_at` so any `workflow_runs` that
// referenced this template stay loadable for observation (a hard delete would
// orphan them). Owner-scoped: only the owner/admin may delete.
export default defineAction({
  description: "Delete a v2 workflow template (soft delete). Owner-scoped.",
  schema: z.object({ id: z.string() }),
  run: async (args) => {
    const access = await resolveAccess("workflow_template", args.id);
    if (!access) throw new Error(`Template ${args.id} not found`);
    if (access.role !== "owner" && access.role !== "admin") {
      throw new Error("Only the owner can delete a template");
    }
    const db = getDb();
    const now = nowIso();
    await db
      .update(schema.workflowTemplates)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.workflowTemplates.id, args.id));
    return { id: args.id, ok: true };
  },
});
