import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// One NodeRun's P1-batch fields (DESIGN §4.4 / §0.6 "P1 batch"): status,
// iteration, dynamic, input+output artifact values, timings, tokens, attempts.
// The executor/microVM/branch/onFailure fields are the P2 batch (§0.6).
export default defineAction({
  description: "Get one NodeRun: status, iteration, dynamic, resolved input + output artifact values, timings, tokens, attempts.",
  schema: z.object({ runId: z.string(), nodeRunId: z.string() }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    const db = getDb();

    const rows = await db
      .select()
      .from(schema.nodeRuns)
      .where(
        and(
          eq(schema.nodeRuns.runId, args.runId),
          eq(schema.nodeRuns.id, args.nodeRunId),
        ),
      )
      .limit(1);
    const nr = rows[0];
    if (!nr) throw new Error(`NodeRun ${args.nodeRunId} not found in run ${args.runId}`);

    async function artifactValue(id: string | null): Promise<unknown> {
      if (!id) return null;
      const ar = await db
        .select({ ref: schema.artifacts.ref })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, id))
        .limit(1);
      if (ar.length === 0) return null;
      try {
        return JSON.parse(ar[0].ref);
      } catch {
        return ar[0].ref;
      }
    }

    return {
      id: nr.id,
      runId: nr.runId,
      nodeId: nr.nodeId,
      type: nr.type,
      title: nr.title,
      assignee: nr.assignee,
      engine: nr.engine,
      model: nr.model,
      status: nr.status,
      iteration: nr.iteration,
      fanoutIndex: nr.fanoutIndex,
      dynamic: nr.dynamic === 1,
      inputRef: nr.inputRef,
      outputRef: nr.outputRef,
      input: await artifactValue(nr.inputRef),
      output: await artifactValue(nr.outputRef),
      error: nr.error,
      attempts: nr.attempts,
      tokensSpent: nr.tokensSpent,
      startedAt: nr.startedAt,
      completedAt: nr.completedAt,
    };
  },
});
