import { defineAction } from "@agent-native/core";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description:
    "List an epic's (集合) children and the blocked-by dependencies between " +
    "them, for the epic-children view on the work item detail page.",
  schema: z.object({
    epicId: z.string().min(1).describe("The epic work item id"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const db = getDb();

    // Confirm the epic is accessible before returning anything.
    const epic = (
      await db
        .select({ id: schema.workItems.id })
        .from(schema.workItems)
        .where(and(eq(schema.workItems.id, args.epicId), ownerScope(schema.workItems)))
        .limit(1)
    )[0];
    if (!epic) throw new Error("Epic work item not found or not accessible");

    const childLinks = await db
      .select({ fromItemId: schema.links.fromItemId })
      .from(schema.links)
      .where(
        and(
          eq(schema.links.toItemId, args.epicId),
          eq(schema.links.linkType, "child-of"),
          ownerScope(schema.links),
        ),
      );
    const childIds = childLinks.map((l) => l.fromItemId);
    if (childIds.length === 0) return { children: [], dependencies: [] };

    const children = await db
      .select({
        id: schema.workItems.id,
        itemKey: schema.workItems.itemKey,
        title: schema.workItems.title,
        status: schema.workItems.status,
        currentStageName: schema.workItems.currentStageName,
        priority: schema.workItems.priority,
      })
      .from(schema.workItems)
      .where(and(inArray(schema.workItems.id, childIds), ownerScope(schema.workItems)));

    const depLinks = await db
      .select({ fromItemId: schema.links.fromItemId, toItemId: schema.links.toItemId })
      .from(schema.links)
      .where(
        and(
          inArray(schema.links.fromItemId, childIds),
          eq(schema.links.linkType, "blocked-by"),
          ownerScope(schema.links),
        ),
      );

    const byId = new Map(children.map((c) => [c.id, c]));
    const dependencies = depLinks.map((l) => ({
      fromId: l.fromItemId,
      toId: l.toItemId,
      fromLabel: byId.get(l.fromItemId)?.itemKey || byId.get(l.fromItemId)?.title || l.fromItemId,
      toLabel: byId.get(l.toItemId)?.itemKey || byId.get(l.toItemId)?.title || l.toItemId,
    }));

    return { children, dependencies };
  },
});
