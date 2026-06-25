/**
 * pool.status — VM pool health snapshot (design §8.7).
 *
 * Returns warm_idle / busy / capacity / queue_waiting counts derived from the
 * live database state. The actual microVM pool state is not yet exposed via a
 * management API, so this is a best-effort DB-derived view: running spawns =
 * busy, pending spawns awaiting dispatch = queue_waiting, capacity from the
 * reconciler's default.
 *
 * G21: new action file for missing pool.status tool.
 */

import { defineAction } from "@agent-native/core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";

/** Default pool capacity — mirrors V3Reconciler DEFAULT_POOL_CAPACITY. */
const DEFAULT_POOL_CAPACITY = 8;

export const poolStatus = defineAction({
  description:
    "Return a snapshot of the microVM worker pool status: warm_idle, busy, capacity, and queue_waiting counts. " +
    "Derived from live DB state (design §8.7). " +
    "busy = currently running spawns; queue_waiting = pending spawns not yet dispatched.",
  schema: z.object({}),
  readOnly: true,
  http: { method: "GET" },
  run: async (_args) => {
    const db = getV3Db();

    // Count spawns by status — only non-terminal spawns matter for pool health
    const spawnCounts = await db
      .select({
        status: v3Schema.v3Spawns.status,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(v3Schema.v3Spawns)
      .where(sql`${v3Schema.v3Spawns.status} IN ('running', 'pending')`)
      .groupBy(v3Schema.v3Spawns.status);

    const countByStatus: Record<string, number> = {};
    for (const row of spawnCounts) {
      countByStatus[row.status] = row.count;
    }

    const busy = countByStatus["running"] ?? 0;
    const queueWaiting = countByStatus["pending"] ?? 0;
    const capacity = DEFAULT_POOL_CAPACITY;
    // warm_idle = slots not occupied by a running spawn
    const warmIdle = Math.max(0, capacity - busy);

    // Count ready nodes waiting for pool slots (from the reconciler queue)
    const readyNodeCount = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(v3Schema.v3Nodes)
      .where(sql`${v3Schema.v3Nodes.status} = 'ready'`);

    return {
      vms: {
        warm_idle: warmIdle,
        busy,
        capacity,
        queue_waiting: queueWaiting,
      },
      readyNodes: readyNodeCount[0]?.count ?? 0,
      note: "Pool counts are DB-derived. warm_idle = capacity − busy. Actual microVM pre-warm state requires the msb pool API (not yet wired).",
    };
  },
});
