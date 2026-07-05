/**
 * run.priority — update the scheduling priority of a V3 run (design §8.4).
 *
 * Priority affects the reconciler dispatch order:
 * nodes are ordered by (run.priority DESC, queued_at ASC).
 * Higher priority = dispatched first when the pool has capacity.
 *
 * G21: new action file for missing run.priority tool.
 */

import { defineAction } from "@agent-native/core";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";

export const runPriority = defineAction({
  description:
    "Update the scheduling priority of a V3 run. Higher values are dispatched first " +
    "when the pool has capacity (reconciler orders by priority DESC, queued_at ASC). " +
    "Only active runs (pending/running/paused) can have their priority changed.",
  schema: z.object({
    runId: z.string().min(1),
    /** New priority value. Higher = higher priority. Default is 0. */
    value: z.number().int(),
  }),
  run: async (args) => {
    const db = getV3Db();

    // Fail-closed owner scope — resolve once and reuse for read + write.
    const runFilter = and(
      eq(v3Schema.v3Runs.id, args.runId),
      eq(v3Schema.v3Runs.ownerEmail, resolveOwnerEmail()),
    );
    const rows = await db
      .select({ id: v3Schema.v3Runs.id, status: v3Schema.v3Runs.status, priority: v3Schema.v3Runs.priority })
      .from(v3Schema.v3Runs)
      .where(runFilter)
      .limit(1);

    if (!rows.length) throw new Error(`Run '${args.runId}' not found`);

    const run = rows[0];
    const terminalStatuses = ["done", "failed", "cancelled"];
    if (terminalStatuses.includes(run.status)) {
      throw new Error(`Run is already ${run.status}; priority changes have no effect on terminal runs`);
    }

    await db
      .update(v3Schema.v3Runs)
      .set({ priority: args.value })
      .where(runFilter);

    return {
      runId: args.runId,
      previousPriority: run.priority,
      priority: args.value,
    };
  },
});
