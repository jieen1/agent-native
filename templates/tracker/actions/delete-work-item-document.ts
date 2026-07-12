import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { eq, and } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export default defineAction({
  description: "Delete a document from a work item.",
  schema: z.object({
    id: z.string().min(1).describe("Document id to delete"),
  }),
  http: { method: "DELETE" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    const now = new Date().toISOString();

    // Find and verify ownership.
    const [doc] = await db
      .select()
      .from(schema.workItemDocuments)
      .where(
        and(
          eq(schema.workItemDocuments.id, args.id),
          ownerScope(schema.workItemDocuments),
        ),
      )
      .limit(1);

    if (!doc) throw new Error("Document not found or access denied");

    // Delete the document row.
    await db
      .delete(schema.workItemDocuments)
      .where(eq(schema.workItemDocuments.id, args.id));

    // Append an activity record on the work item.
    await db.insert(schema.activities).values({
      id: nanoid(),
      workItemId: doc.workItemId,
      actorKind: "human",
      actorName: ownerEmail,
      eventType: "document.removed",
      payload: JSON.stringify({
        documentId: args.id,
        docType: doc.docType,
        title: doc.title,
      }),
      createdAt: now,
      ownerEmail,
      orgId,
    });

    return { ok: true, id: args.id };
  },
});
