import { defineAction } from "@agent-native/core";
import { accessFilter } from "@agent-native/core/sharing";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description: "List workflow runs, newest first.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.workflowRuns)
      .where(accessFilter(schema.workflowRuns, schema.workflowRunShares))
      .orderBy(desc(schema.workflowRuns.startedAt));
    return rows.map((r) => ({
      id: r.id,
      templateId: r.templateId,
      workItemId: r.workItemId,
      status: r.status,
      tokenBudget: r.tokenBudget,
      tokensSpent: r.tokensSpent,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    }));
  },
});
