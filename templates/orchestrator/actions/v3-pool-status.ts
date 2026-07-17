/**
 * spawn-dispatch.status — V3 spawn-dispatch concurrency snapshot (G18).
 *
 * Returns available / busy / capacity / queue_waiting counts derived from live
 * DB state: `capacity` is the reconciler's global spawn-dispatch concurrency
 * ceiling (G18, `DEFAULT_POOL_CAPACITY` in v3-reconciler.ts), `busy` is
 * currently-running spawns, `available` is the unused headroom under that
 * ceiling (capacity − busy), and `queue_waiting` is pending spawns not yet
 * dispatched. This is NOT a microVM warm-pool / pre-warm status — no such pool
 * is wired here (see server/runtime/backpressure.ts's WarmVmPool, which is
 * unwired, and VmSemaphore, which is a separate, real microVM concurrency
 * ceiling only relevant when ORCH_FORCE_MICROVM is enabled).
 *
 * G21: new action file for missing pool.status tool.
 */

import { defineAction } from "@agent-native/core";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getV3Db, v3Schema } from "../server/db/index.js";
import { DEFAULT_POOL_CAPACITY } from "../server/engine/v3-reconciler.js";

export const poolStatus = defineAction({
  description:
    "Return a snapshot of the V3 spawn-dispatch concurrency ceiling (G18): available, busy, capacity, and queue_waiting counts. " +
    "Derived from live DB state. capacity is the reconciler's global dispatch concurrency ceiling (not a microVM pre-warm pool); " +
    "busy = currently running spawns; available = capacity − busy; queue_waiting = pending spawns not yet dispatched.",
  schema: z.object({}),
  readOnly: true,
  http: { method: "GET" },
  run: async (_args) => {
    const db = getV3Db();

    // Count spawns by status — only non-terminal spawns matter for dispatch capacity
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
    // available = dispatch slots not occupied by a running spawn
    const available = Math.max(0, capacity - busy);

    // Count ready nodes waiting for a dispatch slot (from the reconciler queue)
    const readyNodeCount = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(v3Schema.v3Nodes)
      .where(sql`${v3Schema.v3Nodes.status} = 'ready'`);

    return {
      vms: {
        available,
        busy,
        capacity,
        queue_waiting: queueWaiting,
      },
      readyNodes: readyNodeCount[0]?.count ?? 0,
      note: "G18 spawn-dispatch concurrency snapshot, DB-derived. available = capacity − busy. This is not a microVM pre-warm pool.",
    };
  },
});
