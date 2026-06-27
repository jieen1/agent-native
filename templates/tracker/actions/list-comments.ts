import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description: "List all comments on a work item, oldest first.",
  schema: z.object({ workItemId: z.string().min(1) }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const rows = await db
      .select()
      .from(schema.comments)
      .where(and(eq(schema.comments.workItemId, args.workItemId), ownerScope(schema.comments)))
      .orderBy(asc(schema.comments.createdAt));

    return rows.map((r) => ({
      id: r.id,
      workItemId: r.workItemId,
      authorKind: r.authorKind,
      authorName: r.authorName,
      body: r.body,
      createdAt: r.createdAt,
    }));
  },
});
