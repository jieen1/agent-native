import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { resolveAccess } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";

// Create a directed link between two work items (DESIGN §9). `duplicate-of`
// backs resolution=duplicate; `blocked-by` backs the blocked flag. Both
// endpoints must be writable by the caller. Idempotent on (from,to,kind).
export default defineAction({
  description:
    "Link two work items: kind = duplicate-of | blocks | blocked-by | relates-to. The link is directed from `fromItem` to `toItem`. Idempotent.",
  schema: z.object({
    fromItem: z.string(),
    toItem: z.string(),
    kind: z.enum(["duplicate-of", "blocks", "blocked-by", "relates-to"]),
  }),
  run: async (args) => {
    if (args.fromItem === args.toItem) {
      throw new Error("Cannot link a work item to itself");
    }
    // Caller must be able to write the source and at least read the target.
    const fromAccess = await resolveAccess("work_item", args.fromItem);
    if (!fromAccess) throw new Error(`Work item ${args.fromItem} not found`);
    if (fromAccess.role === "viewer")
      throw new Error("Read-only access to source work item");
    const toAccess = await resolveAccess("work_item", args.toItem);
    if (!toAccess) throw new Error(`Work item ${args.toItem} not found`);

    const db = getDb();
    // Idempotent: skip if the exact link already exists.
    const existing = await db
      .select({ id: schema.workItemLinks.id })
      .from(schema.workItemLinks)
      .where(
        and(
          eq(schema.workItemLinks.fromItem, args.fromItem),
          eq(schema.workItemLinks.toItem, args.toItem),
          eq(schema.workItemLinks.kind, args.kind),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return { id: existing[0].id, ok: true, created: false };
    }

    const id = newId("wil");
    await db.insert(schema.workItemLinks).values({
      id,
      fromItem: args.fromItem,
      toItem: args.toItem,
      kind: args.kind,
      createdBy: getRequestUserEmail() ?? "unknown",
      createdAt: nowIso(),
    });
    return { id, ok: true, created: true };
  },
});
