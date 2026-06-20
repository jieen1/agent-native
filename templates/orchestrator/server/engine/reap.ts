// Stuck-run detection via heartbeat (DESIGN §6.4/§13). A durable tick (a
// server-plugin loop, modeled on the framework's jobs/scheduler.ts 60s loop)
// periodically reaps stranded `running` NodeRuns: any whose last_heartbeat is
// older than REAP_THRESHOLD_MS (or never set) is returned to `failed`. A fresh
// heartbeat keeps a row alive. The threshold is an EXPLICIT constant, not an
// ad-hoc clock comparison scattered across the engine.

import { getDb } from "../db/index.js";
import { reapStrandedNodeRuns, type ReapedNodeRun } from "./store.js";

/**
 * How long a `running` NodeRun may go without a heartbeat before the reaper
 * declares it stranded. Explicit + central so tests and the tick agree on one
 * value. 90s gives a real model node ample room to beat between turns while
 * still recovering a crashed scheduler within ~2 ticks.
 */
export const REAP_THRESHOLD_MS = 90_000;

/** How often the durable tick runs the reap sweep. */
export const REAP_TICK_MS = 60_000;

/**
 * One reap sweep: compute the cutoff from the threshold and return stranded
 * running rows to failed. Returns the reaped rows for logging/observability.
 * The clock read here is liveness-only (recovery), never a scheduling decision.
 */
export async function reapOnce(
  thresholdMs: number = REAP_THRESHOLD_MS,
): Promise<ReapedNodeRun[]> {
  const cutoffIso = new Date(Date.now() - thresholdMs).toISOString();
  return reapStrandedNodeRuns(getDb(), cutoffIso);
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the durable reap tick. Idempotent — calling twice is a no-op. The loop
 * keeps the process from exiting on it (`unref`) so it never blocks shutdown.
 */
export function startReapTick(tickMs: number = REAP_TICK_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void reapOnce().catch(() => undefined);
  }, tickMs);
  if (typeof timer.unref === "function") timer.unref();
}

/** Stop the reap tick (test cleanup / shutdown). */
export function stopReapTick(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
