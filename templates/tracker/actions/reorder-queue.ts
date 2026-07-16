import { defineAction } from "@agent-native/core";
import {
  getRequestOrgId,
  getRequestUserEmail,
} from "@agent-native/core/server/request-context";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

// Persists manual drag-and-drop order (and "置顶"/pin-to-top, which the
// frontend implements by moving the target id to index 0 and calling this
// with the full list) for the queue's "可派发" group. Pass every dispatchable
// row's workItemId top-to-bottom — mirrors the tasks template's
// reorder-tasks contract (full ordered id list, not a single from/to pair).
export default defineAction({
  description:
    "Persist manual order for the execution queue's dispatchable rows. Pass " +
    "every dispatchable row's workItemId top-to-bottom (drag reorder or " +
    "pin-to-top); each gets an explicit 1-based `position` (0 is reserved as " +
    "the 'never manually ordered' sentinel). Ids that are not this caller's " +
    "queued rows are skipped, not thrown.",
  schema: z.object({
    workItemIds: z
      .array(z.string().min(1))
      .min(1)
      .max(500)
      .describe(
        "Work item ids in the desired top-to-bottom order for the " +
          "dispatchable ('可派发') queue group.",
      ),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;
    const db = getDb();

    // Inline owner filter directly on exec_queue columns — same convention as
    // list-queue.ts (ownerScope() on a bare execQueue query has previously
    // produced a wrong cross-table column reference; see 5442bec22).
    function queueOwnerFilter() {
      const clauses = [eq(schema.execQueue.ownerEmail, ownerEmail!)];
      if (orgId) clauses.push(eq(schema.execQueue.orgId, orgId));
      return clauses.length === 1 ? clauses[0]! : or(...clauses)!;
    }

    const rows = await db
      .select()
      .from(schema.execQueue)
      .where(
        and(
          queueOwnerFilter(),
          eq(schema.execQueue.status, "queued"),
          inArray(schema.execQueue.workItemId, args.workItemIds),
        ),
      );
    const rowByWorkItem = new Map(rows.map((r) => [r.workItemId, r]));

    const updated: string[] = [];
    // 1-based — 0 is the "never manually ordered" sentinel (see
    // app/lib/queue.ts's sortDispatchable and schema.ts's execQueue docblock).
    let position = 1;
    for (const workItemId of args.workItemIds) {
      const row = rowByWorkItem.get(workItemId);
      if (!row) continue; // not this caller's queued row — skip, don't throw.
      await db
        .update(schema.execQueue)
        .set({ position })
        .where(eq(schema.execQueue.id, row.id));
      updated.push(workItemId);
      position += 1;
    }

    return { updated, count: updated.length };
  },
});
