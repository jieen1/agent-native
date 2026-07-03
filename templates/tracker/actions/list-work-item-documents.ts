import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

const DOC_TYPE_ORDER = [
  "design",
  "prototype",
  "acceptance",
  "spec",
  "other",
] as const;

export default defineAction({
  description:
    "List all documents for a work item, grouped by docType. " +
    "Returns all docType groups even if empty.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item id"),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const rows = await db
      .select()
      .from(schema.workItemDocuments)
      .where(
        and(
          eq(schema.workItemDocuments.workItemId, args.workItemId),
          ownerScope(schema.workItemDocuments),
        ),
      )
      .orderBy(asc(schema.workItemDocuments.createdAt));

    // Group by docType
    const byDocType: Record<string, typeof rows> = {};
    for (const r of rows) {
      if (!byDocType[r.docType]) byDocType[r.docType] = [];
      byDocType[r.docType].push(r);
    }

    // Return in fixed order, always include every group (empty or not)
    const ordered: Record<string, typeof rows> = {};
    for (const dt of DOC_TYPE_ORDER) {
      ordered[dt] = byDocType[dt] ?? [];
    }

    return { byDocType: ordered };
  },
});
