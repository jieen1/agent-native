import { defineAction } from "@agent-native/core";
import { accessFilter } from "@agent-native/core/sharing";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// Parse the stored deliverable JSON into the well-known shape the UI renders
// (PR card / file list). Stored as `{ kind, ref }` text | null; tolerate bad
// JSON rather than throwing the whole list.
function parseDeliverable(raw: string | null): {
  kind: string;
  url?: string;
  title?: string;
  branch?: string;
  files?: Array<{ path: string; url?: string }>;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed.kind === "string") {
      return parsed as {
        kind: string;
        url?: string;
        title?: string;
        branch?: string;
        files?: Array<{ path: string; url?: string }>;
      };
    }
    return null;
  } catch {
    return null;
  }
}

export default defineAction({
  description:
    "List workflow runs, newest first, with resolved template name, work-item title, and parsed deliverable for the global activity table (FRONTEND §8).",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const db = getDb();
    // Left-join the template + work item so the §8 table shows names, not ids.
    // The accessFilter keeps the run scope; the joined rows are denormalized
    // display fields only.
    const rows = await db
      .select({
        id: schema.workflowRuns.id,
        templateId: schema.workflowRuns.templateId,
        workItemId: schema.workflowRuns.workItemId,
        status: schema.workflowRuns.status,
        deliverable: schema.workflowRuns.deliverable,
        tokenBudget: schema.workflowRuns.tokenBudget,
        tokensSpent: schema.workflowRuns.tokensSpent,
        startedAt: schema.workflowRuns.startedAt,
        completedAt: schema.workflowRuns.completedAt,
        templateName: schema.workflowTemplates.name,
        workItemTitle: schema.workItems.title,
        workItemType: schema.workItems.type,
      })
      .from(schema.workflowRuns)
      .leftJoin(
        schema.workflowTemplates,
        eq(schema.workflowTemplates.id, schema.workflowRuns.templateId),
      )
      .leftJoin(
        schema.workItems,
        eq(schema.workItems.id, schema.workflowRuns.workItemId),
      )
      .where(accessFilter(schema.workflowRuns, schema.workflowRunShares))
      .orderBy(desc(schema.workflowRuns.startedAt));

    return rows.map((r) => ({
      id: r.id,
      templateId: r.templateId,
      templateName: r.templateName ?? null,
      workItemId: r.workItemId,
      workItemTitle: r.workItemTitle ?? null,
      workItemType: r.workItemType ?? null,
      status: r.status,
      deliverable: parseDeliverable(r.deliverable),
      tokenBudget: r.tokenBudget,
      tokensSpent: r.tokensSpent,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    }));
  },
});
