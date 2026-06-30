import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description:
    "List all links involving a given work item. For each link, the other item " +
    "is joined in to surface its title, and a direction field ('from' or 'to') " +
    "indicates whether the item is the source or target.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item id to list links for"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();

    // Fetch all links where the work item is either the source or target.
    const links = (
      await db
        .select()
        .from(schema.links)
        .where(
          and(
            ownerScope(schema.links),
            or(
              eq(schema.links.fromItemId, args.workItemId),
              eq(schema.links.toItemId, args.workItemId)
            )
          )
        )
        .limit(500)
    ) as any[];

    // For each link, join the other item to get its title.
    const result = await Promise.all(
      links.map(async (link) => {
        const otherItemId =
          link.fromItemId === args.workItemId ? link.toItemId : link.fromItemId;
        const direction =
          link.fromItemId === args.workItemId ? "from" : "to";

        const otherItem = await db
          .select({ title: schema.workItems.title })
          .from(schema.workItems)
          .where(eq(schema.workItems.id, otherItemId))
          .limit(1);

        return {
          id: link.id,
          fromItemId: link.fromItemId,
          toItemId: link.toItemId,
          linkType: link.linkType,
          otherItemId,
          otherItemTitle: otherItem[0]?.title ?? "",
          direction,
        };
      })
    );

    return result;
  },
});
