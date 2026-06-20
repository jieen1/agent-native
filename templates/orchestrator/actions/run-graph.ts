import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { parseGraph } from "../shared/types.js";

// Live graph: every NodeRun (id,nodeId,status,iteration,fanoutIndex,dynamic) +
// the template edges, for the canvas overlay (DESIGN §4.4).
export default defineAction({
  description: "Get a run's live graph: every NodeRun (status/iteration/fanoutIndex/dynamic) plus the template edges.",
  schema: z.object({ runId: z.string() }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    const run = access.resource as Record<string, unknown>;
    const db = getDb();

    const tplRows = await db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, String(run.templateId)))
      .limit(1);
    const edges = tplRows[0] ? parseGraph(tplRows[0].graph).edges : [];

    const rows = await db
      .select()
      .from(schema.nodeRuns)
      .where(eq(schema.nodeRuns.runId, args.runId));

    const nodeRuns = rows
      .map((nr) => ({
        id: nr.id,
        nodeId: nr.nodeId,
        type: nr.type,
        title: nr.title,
        status: nr.status,
        iteration: nr.iteration,
        fanoutIndex: nr.fanoutIndex,
        dynamic: nr.dynamic === 1,
        startedAt: nr.startedAt,
        completedAt: nr.completedAt,
      }))
      .sort((a, b) =>
        a.nodeId === b.nodeId
          ? a.iteration - b.iteration || a.fanoutIndex - b.fanoutIndex
          : a.nodeId < b.nodeId
            ? -1
            : 1,
      );

    return { runId: args.runId, status: run.status as string, nodeRuns, edges };
  },
});
