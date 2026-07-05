import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { eq, and } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { resolveActorKind } from "../server/lib/activity.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export default defineAction({
  description: "Add a human comment to a work item.",
  schema: z.object({
    workItemId: z.string().min(1),
    body: z.string().min(1),
    authorName: z.string().optional(),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    const item = (
      await db
        .select({ id: schema.workItems.id })
        .from(schema.workItems)
        .where(and(eq(schema.workItems.id, args.workItemId), ownerScope(schema.workItems)))
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found");

    const id = nanoid();
    const now = new Date().toISOString();
    await db.insert(schema.comments).values({
      id,
      workItemId: args.workItemId,
      authorKind: "human",
      authorName: args.authorName ?? ownerEmail,
      body: args.body,
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    await db.insert(schema.activities).values({
      id: nanoid(),
      workItemId: args.workItemId,
      actorKind: resolveActorKind(ctx),
      actorName: args.authorName ?? ownerEmail,
      eventType: "评论",
      payload: JSON.stringify({ commentId: id }),
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return { id, workItemId: args.workItemId, body: args.body, createdAt: now };
  },
});
