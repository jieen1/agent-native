/**
 * @deprecated Use `v3-workflow` action `workflow.delete` instead.
 * This V1 action is retained for backward compatibility only.
 */
import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { nowIso } from "./_util.js";

export default defineAction({
  description: "Delete a workflow (soft delete).",
  schema: z.object({ id: z.string() }),
  run: async (args) => {
    const access = await resolveAccess("workflow", args.id);
    if (!access) throw new Error(`Workflow ${args.id} not found`);
    if (access.role !== "owner" && access.role !== "admin") {
      throw new Error("Only the owner can delete a workflow");
    }
    const db = getDb();
    await db
      .update(schema.workflows)
      .set({ deletedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(schema.workflows.id, args.id));
    return { id: args.id, ok: true };
  },
});
