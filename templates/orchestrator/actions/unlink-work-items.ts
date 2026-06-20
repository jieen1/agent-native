import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// Remove a work-item link, either by its id or by the (fromItem,toItem,kind)
// triple (DESIGN §9). The caller must be able to write the source item.
export default defineAction({
  description:
    "Remove a work-item link, by `id` OR by the (fromItem, toItem, kind) triple.",
  schema: z
    .object({
      id: z.string().optional(),
      fromItem: z.string().optional(),
      toItem: z.string().optional(),
      kind: z
        .enum(["duplicate-of", "blocks", "blocked-by", "relates-to"])
        .optional(),
    })
    .refine((v) => !!v.id || (!!v.fromItem && !!v.toItem && !!v.kind), {
      message: "Provide either id, or all of fromItem/toItem/kind",
    }),
  run: async (args) => {
    const db = getDb();

    // Resolve the link row first to find its source item for the access check.
    let row:
      | { id: string; fromItem: string; toItem: string; kind: string }
      | undefined;
    if (args.id) {
      const rows = await db
        .select()
        .from(schema.workItemLinks)
        .where(eq(schema.workItemLinks.id, args.id))
        .limit(1);
      row = rows[0];
    } else {
      const rows = await db
        .select()
        .from(schema.workItemLinks)
        .where(
          and(
            eq(schema.workItemLinks.fromItem, args.fromItem!),
            eq(schema.workItemLinks.toItem, args.toItem!),
            eq(schema.workItemLinks.kind, args.kind!),
          ),
        )
        .limit(1);
      row = rows[0];
    }
    if (!row) throw new Error("Link not found");

    const fromAccess = await resolveAccess("work_item", row.fromItem);
    if (!fromAccess) throw new Error(`Work item ${row.fromItem} not found`);
    if (fromAccess.role === "viewer")
      throw new Error("Read-only access to source work item");

    await db
      .delete(schema.workItemLinks)
      .where(eq(schema.workItemLinks.id, row.id));
    return { id: row.id, ok: true };
  },
});
