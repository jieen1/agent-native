import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { nowIso } from "./_util.js";

// Soft delete — sets deleted_at so list queries hide it but history is kept.
export default defineAction({
  description: "Delete a task (soft delete).",
  schema: z.object({ id: z.string() }),
  run: async (args) => {
    const access = await resolveAccess("task", args.id);
    if (!access) throw new Error(`Task ${args.id} not found`);
    if (access.role !== "owner" && access.role !== "admin") {
      throw new Error("Only the owner can delete a task");
    }
    const db = getDb();
    await db
      .update(schema.tasks)
      .set({ deletedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(schema.tasks.id, args.id));
    return { id: args.id, ok: true };
  },
});
