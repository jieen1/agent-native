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

    const row = await db
      .select({
        id: schema.agentDefs.id,
        builtin: schema.agentDefs.builtin,
        name: schema.agentDefs.name,
      })
      .from(schema.agentDefs)
      .where(eq(schema.agentDefs.id, args.id))
      .limit(1);

    // Nonexistent id, builtin row, and "exists but I'm not owner/admin" all
    // throw the SAME message — probing must not distinguish which case
    // applies (orchestrator-agents-pool-design-review.md §1.4.5). The access
    // check happens before/alongside the builtin check rather than after it.
    const access =
      row.length > 0 ? await resolveAccess("agent_def", args.id) : null;
    const canDelete =
      row.length > 0 &&
      row[0].builtin === 0 &&
      !!access &&
      (access.role === "owner" || access.role === "admin");

    if (!canDelete) {
      throw new Error(`Agent '${args.id}' not found`);
    }

    await db.delete(schema.agentDefs).where(eq(schema.agentDefs.id, args.id));

    return { id: args.id, name: row[0].name, ok: true };
  },
});
