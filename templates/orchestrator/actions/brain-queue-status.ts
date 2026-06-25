// brain-queue-status (LEVEL-1). The whole-queue snapshot for the brain
// concurrency limiter the UI shows as the capacity indicator and the brain reads
// to plan order: the configured degree, the live running/queued counts, the
// per-status breakdown, and the durable driver self-observation
// (driverAlive/lastTickAt/reapsFired/tasksPromoted) so a dead tick is visible
// rather than a silently-wedged queue. Read-only.

import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { getBrainConcurrency } from "../server/queue/brain-concurrency.js";
import { getBrainDriverHealth } from "../server/queue/brain-driver.js";
import { v3DbExec, isV3PostgresConfigured } from "../server/db/v3.js";

export default defineAction({
  description:
    "Return the orchestrator BRAIN-task queue snapshot: brainConcurrency (degree), " +
    "running/queued counts, the per-status breakdown, and brain-driver health " +
    "(driverAlive/lastTickAt/reapsFired/tasksPromoted). Read-only.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const brainConcurrency = await getBrainConcurrency();
    const health = getBrainDriverHealth();

    const byStatus: Record<string, number> = {
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    if (isV3PostgresConfigured()) {
      try {
        const res = await v3DbExec(
          `SELECT status, count(*)::int AS n FROM brain_tasks GROUP BY status`,
        );
        for (const row of res.rows as Array<Record<string, unknown>>) {
          byStatus[String(row.status)] = Number(row.n ?? 0);
        }
      } catch {
        // brain_tasks not migrated yet / DB unreachable — return zeros.
      }
    }

    return {
      brainConcurrency,
      running: byStatus.running ?? 0,
      queued: byStatus.queued ?? 0,
      byStatus,
      driverAlive: health.driverAlive,
      lastTickAt: health.lastTickAt,
      reapsFired: health.reapsFired,
      tasksPromoted: health.tasksPromoted,
      lastError: health.lastError,
    };
  },
});
