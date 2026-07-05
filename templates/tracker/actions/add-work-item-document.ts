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
import { resolveActorKind, resolveActorName } from "../server/lib/activity.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

const DOC_TYPES = [
  "design",
  "prototype",
  "acceptance",
  "spec",
  "other",
] as const;

export default defineAction({
  description:
    "Add a document link (design/prototype/acceptance/spec/other) to a work item.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item id"),
    docType: z.enum(DOC_TYPES).describe("Document type"),
    title: z.string().min(1).describe("Document title"),
    url: z.string().url().describe("Document URL"),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    const now = new Date().toISOString();

    // Validate that the work item exists and is accessible.
    const item = (
      await db
        .select({ id: schema.workItems.id })
        .from(schema.workItems)
        .where(
          and(
            eq(schema.workItems.id, args.workItemId),
            ownerScope(schema.workItems),
          ),
        )
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found or not accessible");

    // Insert the document.
    const id = nanoid();
    const doc = await db
      .insert(schema.workItemDocuments)
      .values({
        id,
        workItemId: args.workItemId,
        docType: args.docType,
        title: args.title,
        url: args.url,
        createdAt: now,
        ownerEmail,
        orgId,
      })
      .returning();

    // Append an activity record.
    const actorKind = resolveActorKind(ctx);
    await db.insert(schema.activities).values({
      id: nanoid(),
      workItemId: args.workItemId,
      actorKind,
      actorName: resolveActorName(actorKind, ownerEmail),
      eventType: "document.added",
      payload: JSON.stringify({
        documentId: id,
        docType: args.docType,
        title: args.title,
      }),
      createdAt: now,
      ownerEmail,
      orgId,
    });

    return doc[0];
  },
});
