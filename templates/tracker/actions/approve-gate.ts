import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description: "Approve a pending approval gate. Records the decider and timestamp.",
  schema: z.object({
    id: z.string().min(1).describe("Approval ID to approve"),
    reason: z.string().optional().describe("Optional approval note / reason"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();

    const rows = await db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, args.id))
      .limit(1);

    if (rows.length === 0) {
      throw new Error(`Approval ${args.id} not found`);
    }

    const approval = rows[0]!;
    if (approval.status !== "pending") {
      throw new Error(
        `Approval ${args.id} is already ${approval.status} and cannot be approved`,
      );
    }

    const now = new Date().toISOString();

    await db
      .update(schema.approvals)
      .set({
        status: "approved",
        decidedBy: ownerEmail,
        reason: args.reason ?? null,
        decidedAt: now,
      })
      .where(eq(schema.approvals.id, args.id));

    return {
      id: args.id,
      status: "approved",
      decidedBy: ownerEmail,
      reason: args.reason ?? null,
      decidedAt: now,
    };
  },
});
