import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// Delete a user-defined agent definition (DESIGN §7).
// Builtin agents cannot be deleted. Owner/admin-scoped.
export default defineAction({
  description:
    "Delete an agent definition by id (DESIGN §7). Builtin agents cannot be deleted. Owner/admin-scoped.",
  schema: z.object({
    id: z.string(),
  }),
  run: async (args) => {
    const db = getDb();

    // Confirm row exists and is not builtin
    const row = await db
      .select({
        id: schema.agentDefs.id,
        builtin: schema.agentDefs.builtin,
        name: schema.agentDefs.name,
      })
      .from(schema.agentDefs)
      .where(eq(schema.agentDefs.id, args.id))
      .limit(1);

    if (row.length === 0) throw new Error(`Agent '${args.id}' not found`);
    if (row[0].builtin !== 0)
      throw new Error(
        "Builtin agent cannot be deleted",
      );

    const access = await resolveAccess("agent_def", args.id);
    if (!access) throw new Error(`Agent ${args.id} not found`);
    if (access.role !== "owner" && access.role !== "admin") {
      throw new Error("Only the owner can delete an agent definition");
    }

    await db
      .delete(schema.agentDefs)
      .where(eq(schema.agentDefs.id, args.id));

    return { id: args.id, name: row[0].name, ok: true };
  },
});