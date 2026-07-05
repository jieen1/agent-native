import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { resolveActorKind, resolveActorName } from "../server/lib/activity.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export default defineAction({
  description:
    "Add a typed link between two work items. Validates that both items exist " +
    "and that the caller owns the from-item. Prevents duplicate links and " +
    "appends a 'link' activity record on the from-item.",
  schema: z.object({
    fromItemId: z.string().min(1).describe("Source work item id"),
    toItemId: z.string().min(1).describe("Target work item id"),
    linkType: z.string().min(1).describe("Link type, e.g. depends-on, blocks, relates-to"),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    const now = new Date().toISOString();

    // Validate that the target work item exists.
    const toItem = await db
      .select()
      .from(schema.workItems)
      .where(eq(schema.workItems.id, args.toItemId))
      .limit(1);
    if (toItem.length === 0) throw new Error("Target work item not found");

    // Validate that the source work item exists and is owned by the caller.
    const fromItem = (
      await db
        .select()
        .from(schema.workItems)
        .where(and(eq(schema.workItems.id, args.fromItemId), ownerScope(schema.workItems)))
        .limit(1)
    )[0];
    if (!fromItem) throw new Error("Source work item not found or not accessible");

    // Check for duplicate link.
    const existing = await db
      .select()
      .from(schema.links)
      .where(
        and(
          eq(schema.links.fromItemId, args.fromItemId),
          eq(schema.links.toItemId, args.toItemId),
          eq(schema.links.linkType, args.linkType)
        )
      )
      .limit(1);
    if (existing.length > 0) throw new Error("Link already exists");

    // Insert the link.
    const id = nanoid();
    const link = await db
      .insert(schema.links)
      .values({
        id,
        fromItemId: args.fromItemId,
        toItemId: args.toItemId,
        linkType: args.linkType,
        createdAt: now,
        ownerEmail,
        orgId,
      })
      .returning();

    // Append a 'link' activity record on the from-item.
    const actorKind = resolveActorKind(ctx);
    await db.insert(schema.activities).values({
      id: nanoid(),
      workItemId: args.fromItemId,
      actorKind,
      actorName: resolveActorName(actorKind, ownerEmail),
      eventType: "link",
      payload: JSON.stringify({
        fromItemId: args.fromItemId,
        toItemId: args.toItemId,
        linkType: args.linkType,
      }),
      createdAt: now,
      ownerEmail,
      orgId,
    });

    return link[0];
  },
});
