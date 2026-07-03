import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope, and } from "../server/lib/access.js";

export default defineAction({
  description:
    "List approval records. Filter by sprintId and/or status. " +
    "Returns newest first.",
  schema: z.object({
    sprintId: z
      .string()
      .optional()
      .describe("Filter by sprint ID"),
    status: z
      .enum(["pending", "approved", "rejected"])
      .optional()
      .describe("Filter by status"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const db = getDb();

    const rows = await db
      .select()
      .from(schema.approvals)
      .where(
        and(
          ownerScope(schema.approvals),
          args.sprintId ? eq(schema.approvals.sprintId, args.sprintId) : undefined,
          args.status ? eq(schema.approvals.status, args.status) : undefined,
        ),
      )
      .orderBy(desc(schema.approvals.createdAt))
      .limit(200);

    return rows.map((r) => ({
      id: r.id,
      sprintId: r.sprintId,
      workItemId: r.workItemId,
      gateKey: r.gateKey,
      gateRef: r.gateRef,
      status: r.status,
      requestedBy: r.requestedBy,
      decidedBy: r.decidedBy,
      reason: r.reason,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    }));
  },
});
