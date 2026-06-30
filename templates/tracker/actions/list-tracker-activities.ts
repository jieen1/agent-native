import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description: "List activity events for a work item, newest first.",
  schema: z.object({
    workItemId: z.string().min(1),
    limit: z.number().int().positive().optional(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const limit = args.limit ?? 50;
    const rows = await db
      .select()
      .from(schema.activities)
      .where(and(eq(schema.activities.workItemId, args.workItemId), ownerScope(schema.activities)))
      .orderBy(desc(schema.activities.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      workItemId: r.workItemId,
      actorKind: r.actorKind,
      actorName: r.actorName,
      eventType: r.eventType,
      payload: (() => {
        try { return JSON.parse(r.payload ?? "{}"); } catch { return {}; }
      })(),
      createdAt: r.createdAt,
    }));
  },
});
