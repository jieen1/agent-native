import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";

// node-report (DESIGN §10): a sub-agent attaches an INTERIM artifact/progress
// only. It MUST NOT set a node to done/failed or change a terminal status — the
// SCHEDULER owns terminal status when the node's run completes, so the two paths
// never double-write. This action therefore:
//   - writes an interim artifact (kind: "progress" or "interim") linked to the
//     node_run, and refreshes last_heartbeat (liveness, §6.4)
//   - NEVER touches node_runs.status / output_ref / error / completed_at
//   - rejects a request that already sits on a TERMINAL node_run (done/failed/
//     skipped) so a late report can't resurrect or contradict a settled node.
export default defineAction({
  description:
    "Attach interim progress or an interim artifact to a running NodeRun (sub-agent reporting). Cannot set terminal status — the scheduler owns done/failed.",
  schema: z
    .object({
      runId: z.string(),
      nodeRunId: z.string(),
      progress: z.string().optional(),
      artifact: z.unknown().optional(),
      summary: z.string().optional(),
    })
    .refine((v) => v.progress !== undefined || v.artifact !== undefined, {
      message: "Provide at least one of progress or artifact.",
    }),
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");

    const db = getDb();
    const rows = await db
      .select()
      .from(schema.nodeRuns)
      .where(eq(schema.nodeRuns.id, args.nodeRunId))
      .limit(1);
    const nr = rows[0];
    if (!nr || nr.runId !== args.runId) {
      throw new Error(
        `NodeRun ${args.nodeRunId} not found in run ${args.runId}`,
      );
    }

    // HARD GUARD: a terminal node is owned by the scheduler — reject the report
    // so node-report can never double-write or override a settled status.
    if (
      nr.status === "done" ||
      nr.status === "failed" ||
      nr.status === "skipped"
    ) {
      throw new Error(
        `NodeRun ${args.nodeRunId} is terminal (status=${nr.status}); node-report ` +
          `cannot change a terminal status — the scheduler owns done/failed.`,
      );
    }

    const now = nowIso();
    const value =
      args.artifact !== undefined ? args.artifact : { progress: args.progress };
    const id = newId("art");
    await db.insert(schema.artifacts).values({
      id,
      runId: args.runId,
      nodeRunId: args.nodeRunId,
      kind: args.artifact !== undefined ? "interim" : "progress",
      ref: JSON.stringify(value ?? null),
      summary: args.summary ?? args.progress ?? null,
      createdAt: now,
    });

    // Refresh liveness only — NEVER status/output_ref/error/completed_at.
    await db
      .update(schema.nodeRuns)
      .set({ lastHeartbeat: now })
      .where(eq(schema.nodeRuns.id, args.nodeRunId));

    return {
      runId: args.runId,
      nodeRunId: args.nodeRunId,
      artifactId: id,
      ok: true,
    };
  },
});
