import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// Run status + counts + tokens + remaining budget (DESIGN §4.4).
export default defineAction({
  description: "Get a workflow run's status, node-status counts, tokens, and remaining budget.",
  schema: z.object({ runId: z.string() }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    const run = access.resource as Record<string, unknown>;
    const db = getDb();

    const nodeRuns = await db
      .select()
      .from(schema.nodeRuns)
      .where(eq(schema.nodeRuns.runId, args.runId));

    const counts: Record<string, number> = {};
    for (const nr of nodeRuns) {
      counts[nr.status] = (counts[nr.status] ?? 0) + 1;
    }

    const tokenBudget = (run.tokenBudget as number | null) ?? null;
    const tokensSpent = Number(run.tokensSpent ?? 0);
    return {
      runId: args.runId,
      templateId: String(run.templateId),
      workItemId: (run.workItemId as string | null) ?? null,
      status: run.status as string,
      deliverable: run.deliverable
        ? JSON.parse(String(run.deliverable))
        : null,
      tokenBudget,
      tokensSpent,
      budgetRemaining: tokenBudget == null ? null : tokenBudget - tokensSpent,
      nodeRunCount: nodeRuns.length,
      counts,
      startedAt: (run.startedAt as string | null) ?? null,
      completedAt: (run.completedAt as string | null) ?? null,
    };
  },
});
