import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// list-audit (DESIGN §7.4.7): read the append-only audit trail — run control,
// transition-work-item, credential resolution — newest first, optionally
// filtered by target or action. Scoped to the request owner so a user only sees
// their own trail. Read-only.
export default defineAction({
  description:
    "List audit-log rows (run control, transition-work-item, credential resolution) newest first. Optionally filter by targetType/targetId or action. Read-only; scoped to the caller.",
  schema: z.object({
    targetType: z
      .string()
      .optional()
      .describe("Filter by target kind, e.g. workflow_run | work_item | credential"),
    targetId: z.string().optional().describe("Filter by a specific target id"),
    action: z.string().optional().describe("Filter by an action key, e.g. run.cancel"),
    limit: z.coerce.number().int().positive().max(500).optional(),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const db = getDb();
    const owner = getRequestUserEmail() ?? "local@localhost";

    const conds = [eq(schema.auditLog.ownerEmail, owner)];
    if (args.targetType)
      conds.push(eq(schema.auditLog.targetType, args.targetType));
    if (args.targetId) conds.push(eq(schema.auditLog.targetId, args.targetId));
    if (args.action) conds.push(eq(schema.auditLog.action, args.action));

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(and(...conds))
      .orderBy(desc(schema.auditLog.at))
      .limit(args.limit ?? 100);

    return {
      count: rows.length,
      rows: rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        detail: r.detail ? JSON.parse(r.detail) : null,
        at: r.at,
      })),
    };
  },
});
