// The durable queue driver (DESIGN §6.4 D-3 / §13). A single server-plugin tick
// — modeled on the framework's jobs/scheduler.ts 60s loop — owns BOTH:
//   1. draining the queue through the worker pool (claim → run → settle), and
//   2. the SQL heartbeat/reap that returns stranded claimed/running items to
//      queued after a worker crash/redeploy.
// Living in one place is the whole point: without one durable owner a
// multi-instance deploy double-schedules or strands items (§14).
//
// Self-observation (the acceptance item): the tick records schedulerAlive /
// lastTickAt / reapsFired so a UI / queue-status can tell whether the driver is
// alive or silently dead, rather than a wedged queue with no signal.

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { drainQueue } from "./worker-pool.js";
import { reapQueueOnce, QUEUE_REAP_TICK_MS } from "./reap.js";

/** Liveness + activity the tick exposes (read by queue-status). */
export interface SchedulerHealth {
  /** True while the tick interval is installed. */
  schedulerAlive: boolean;
  /** ISO timestamp of the last completed tick, or null if it never ran. */
  lastTickAt: string | null;
  /** Cumulative count of work items the reap returned to queued. */
  reapsFired: number;
  /** Cumulative count of items the pool processed across all ticks. */
  itemsProcessed: number;
  /** The last tick's error message, if it threw (cleared on the next success). */
  lastError: string | null;
}

// Process-local health. In a single-isolate self-host this is the live driver
// state; a multi-isolate deploy would persist it (P6). Module-level so
// queue-status reads the same object the tick writes.
const health: SchedulerHealth = {
  schedulerAlive: false,
  lastTickAt: null,
  reapsFired: 0,
  itemsProcessed: 0,
  lastError: null,
};

/** Read a snapshot of the driver's self-observation. */
export function getSchedulerHealth(): SchedulerHealth {
  return { ...health };
}

/**
 * One driver tick: reap stranded items first (so a crashed worker's item is
 * re-queued before this tick claims), then drain the queue with the worker pool.
 * Idempotent and safe to call manually (the headless tick path used in tests).
 * Runs inside a request context for ownable scoping.
 */
export async function driveOnce(opts: {
  ownerEmail: string;
  orgId: string | null;
}): Promise<{ reaped: number; processed: number }> {
  return runWithRequestContext(
    { userEmail: opts.ownerEmail, orgId: opts.orgId ?? undefined },
    async () => {
      const reaped = await reapQueueOnce();
      health.reapsFired += reaped.length;
      const drained = await drainQueue({
        ownerEmail: opts.ownerEmail,
        orgId: opts.orgId,
      });
      health.itemsProcessed += drained.processed.length;
      health.lastTickAt = new Date().toISOString();
      health.lastError = null;
      return { reaped: reaped.length, processed: drained.processed.length };
    },
  );
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Start the durable driver tick. Idempotent. The loop is `unref`-ed so it never
 * blocks shutdown, and re-entrancy is guarded so a slow tick never overlaps
 * itself. The driver runs as the deployment-wide local user (settings are
 * global, key-only — §13 gotcha; the headless scheduler reads them with no
 * per-request context, which is why this works).
 */
export function startQueueDriver(
  opts: { ownerEmail?: string; orgId?: string | null; tickMs?: number } = {},
): void {
  if (timer) return;
  const ownerEmail = opts.ownerEmail ?? "local@localhost";
  const orgId = opts.orgId ?? null;
  const tickMs = opts.tickMs ?? QUEUE_REAP_TICK_MS;
  health.schedulerAlive = true;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void driveOnce({ ownerEmail, orgId })
      .catch((err: unknown) => {
        health.lastError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        ticking = false;
      });
  }, tickMs);
  if (typeof timer.unref === "function") timer.unref();
}

/** Stop the driver tick (test cleanup / shutdown). */
export function stopQueueDriver(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  health.schedulerAlive = false;
}
