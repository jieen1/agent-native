// V3 Archive action (P4-A)
// Marks a run as archived and optionally cascades cleanup of associated
// nodes, spawns, artifacts, and events.

import { defineAction } from "@agent-native/core";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";

export const runArchive = defineAction({
  description:
    "Archive a completed V3 run. Marks the run as archived (hidden from default list). Optionally purges associated nodes, spawns, artifacts, and events.",
  schema: z.object({
    runId: z.string(),
    /** If true, also DELETE associated nodes, spawns, artifacts, events. */
    purge: z.boolean().default(false),
  }),
  run: async (args) => {
    const db = getV3Db();

    // Verify the run exists and is in a terminal state
    const runRows = await db
      .select({
        id: v3Schema.v3Runs.id,
        status: v3Schema.v3Runs.status,
        archived: v3Schema.v3Runs.archived,
      })
      .from(v3Schema.v3Runs)
      .where(eq(v3Schema.v3Runs.id, args.runId))
      .limit(1);

    if (!runRows.length) {
      throw new Error(`Run '${args.runId}' not found`);
    }

    const run = runRows[0];
    const terminalStatuses = ["done", "failed", "cancelled"];
    if (!terminalStatuses.includes(run.status)) {
      throw new Error(
        `Cannot archive run in '${run.status}' state. Archive only pending/terminal runs.`,
      );
    }

    // If already archived, return early
    if (run.archived !== 0) {
      return { runId: args.runId, archived: true, purged: false, message: "Already archived" };
    }

    // Mark archived
    await db
      .update(v3Schema.v3Runs)
      .set({ archived: 1 })
      .where(eq(v3Schema.v3Runs.id, args.runId));

    if (!args.purge) {
      return { runId: args.runId, archived: true, purged: false };
    }

    // Cascade purge: artifacts first (FK dependency), then spawns, nodes, events, patches
    const artifactResult = await db
      .delete(v3Schema.v3Artifacts)
      .where(
        sql`${v3Schema.v3Artifacts.spawnId} IN (
          SELECT id FROM v3_spawns
          WHERE node_id IN (
            SELECT id FROM v3_nodes WHERE run_id = ${args.runId}
          )
        )`,
      );

    const spawnResult = await db
      .delete(v3Schema.v3Spawns)
      .where(
        sql`${v3Schema.v3Spawns.nodeId} IN (
          SELECT id FROM v3_nodes WHERE run_id = ${args.runId}
        )`,
      );

    const nodeResult = await db
      .delete(v3Schema.v3Nodes)
      .where(eq(v3Schema.v3Nodes.runId, args.runId));

    const eventResult = await db
      .delete(v3Schema.v3Events)
      .where(eq(v3Schema.v3Events.runId, args.runId));

    const patchResult = await db
      .delete(v3Schema.v3Patches)
      .where(eq(v3Schema.v3Patches.runId, args.runId));

    return {
      runId: args.runId,
      archived: true,
      purged: true,
      deletedArtifacts: artifactResult?.rowCount ?? 0,
      deletedSpawns: spawnResult?.rowCount ?? 0,
      deletedNodes: nodeResult?.rowCount ?? 0,
      deletedEvents: eventResult?.rowCount ?? 0,
      deletedPatches: patchResult?.rowCount ?? 0,
    };
  },
});
