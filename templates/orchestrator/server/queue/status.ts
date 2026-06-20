// Queue status aggregation (DESIGN §6.4). Returns the two concurrency ceilings
// (concurrencyDegree + maxConcurrentVMs) and the live execState counts, plus the
// driver self-observation (schedulerAlive / lastTickAt / reapsFired) so a stuck
// or dead tick is visible rather than a silently-wedged queue.

import { getDbExec } from "../db/index.js";
import { getConcurrencyDegree, getMaxConcurrentVMs } from "./concurrency.js";
import { getSchedulerHealth } from "./driver.js";
import { getVmSemaphore } from "../runtime/backpressure.js";

export interface QueueStatus {
  /** Worker-pool width — how many work items run at once (§6.4 ceiling 1). */
  concurrencyDegree: number;
  /** Items currently running (workflow_run executing). */
  running: number;
  /** Items waiting for a worker slot, priority-ordered. */
  queued: number;
  /** Items atomically grabbed, run starting (transient, sub-second). */
  claimed: number;
  /** microVM capacity ceiling (§6.4 ceiling 2). */
  maxConcurrentVMs: number;
  /** microVMs in use right now (P3b runs on the engine, no real VMs → 0). */
  vmsInUse: number;
  /** True while the durable driver tick is installed. */
  schedulerAlive: boolean;
  /** ISO of the last completed tick, or null. */
  lastTickAt: string | null;
  /** Cumulative items the reap returned to queued. */
  reapsFired: number;
}

/** Count work items grouped by execState (one grouped query). */
async function execStateCounts(): Promise<Record<string, number>> {
  const client = getDbExec();
  const { rows } = await client.execute({
    sql: `SELECT exec_state, COUNT(*) AS n FROM work_items GROUP BY exec_state`,
    args: [],
  });
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[String(row.exec_state)] = Number(row.n ?? 0);
  }
  return counts;
}

/** Build the full queue-status payload. */
export async function getQueueStatus(): Promise<QueueStatus> {
  const [degree, counts] = await Promise.all([
    getConcurrencyDegree(),
    execStateCounts(),
  ]);
  const health = getSchedulerHealth();
  return {
    concurrencyDegree: degree,
    running: counts.running ?? 0,
    queued: counts.queued ?? 0,
    claimed: counts.claimed ?? 0,
    maxConcurrentVMs: getMaxConcurrentVMs(),
    // Live microVM slots held by the VM-capacity semaphore (DESIGN §4.1). On the
    // engine-only path no VMs are provisioned, so this reads 0; once a microVM
    // node is running it reflects the real in-use count the cap bounds.
    vmsInUse: getVmSemaphore().inUse,
    schedulerAlive: health.schedulerAlive,
    lastTickAt: health.lastTickAt,
    reapsFired: health.reapsFired,
  };
}
