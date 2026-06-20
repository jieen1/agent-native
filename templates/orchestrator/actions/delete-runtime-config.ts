import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description: "Delete a saved model runtime.",
  schema: z.object({ id: z.string() }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const db = getDb();
    await db
      .delete(schema.runtimeConfigs)
      .where(
        and(
          eq(schema.runtimeConfigs.id, args.id),
          eq(schema.runtimeConfigs.ownerEmail, ownerEmail),
        ),
      );
    return { id: args.id, ok: true };
  },
});
