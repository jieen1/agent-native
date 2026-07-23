// v3-lifecycle-sweep — periodic driver for the P4-A data lifecycle cleanup
// (server/lib/v3-lifecycle.ts's runLifecycleCleanup: artifact TTL, event TTL,
// expired-run archival listing).
//
// Confirmed via a full repo-wide reference scan (2026-07-23 SDLC audit):
// runLifecycleCleanup — despite its own doc comment calling it the "daily
// cron entry point" — was referenced ONLY inside v3-lifecycle.ts itself.
// Nothing in the running app (no action, no plugin, no sweep) ever called
// it, so v3_artifacts/v3_events grew unbounded regardless of their TTL
// columns/config existing and working correctly when invoked directly (this
// is the SAME "mechanism correct, nothing ever triggers it" shape as the
// 2026-07-20 workspace-disk incident and the 2026-07-23 F9 writeback
// incident this session already fixed — see v3-workspace-reap-sweep.ts and
// v3-reconciler.ts's matching history). This module is the missing trigger;
// runLifecycleCleanup's own SQL is unchanged.

import { isPostgres } from "@agent-native/core/db";

import { runLifecycleCleanup } from "../lib/v3-lifecycle.js";

/**
 * How often (ms) to run the lifecycle cleanup sweep.
 * Env: V3_LIFECYCLE_SWEEP_INTERVAL_MS. Default: 6 hours — the underlying
 * DELETE/UPDATE queries are cheap and idempotent (re-running early is
 * harmless), so a coarse cadence is preferred over a fragile "once a day at
 * exactly this instant" scheduler that a process restart could skip
 * entirely.
 */
export function defaultLifecycleSweepIntervalMs(): number {
  const raw = process.env.V3_LIFECYCLE_SWEEP_INTERVAL_MS;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 6 * 60 * 60 * 1000;
}

/**
 * Run one lifecycle cleanup sweep. Best-effort — a failure never throws out
 * of the timer tick; logged and swallowed so one bad tick can't kill the
 * durable interval (mirrors v3-workspace-reap-sweep.ts / v3-run-reconcile-
 * sweep.ts's discipline).
 */
export async function lifecycleSweepOnce(): Promise<{
  artifactsDeleted: number;
  eventsDeleted: number;
  expiredRuns: number;
} | null> {
  if (!isPostgres()) return null;
  try {
    const result = await runLifecycleCleanup();
    if (result.artifactsDeleted > 0 || result.eventsDeleted > 0) {
      console.log(
        `[v3-lifecycle-sweep] artifacts_deleted=${result.artifactsDeleted} ` +
          `events_deleted=${result.eventsDeleted} expired_runs=${result.expiredRuns}`,
      );
    }
    return result;
  } catch (err) {
    console.warn(
      "[v3-lifecycle-sweep] sweep failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the durable lifecycle cleanup sweep. Idempotent — a second call is a
 * no-op. The loop is `unref`-ed so it never blocks process shutdown (modeled
 * on server/brain/brain-monitor.ts's startBrainMonitorTick).
 */
export function startLifecycleSweep(
  intervalMs: number = defaultLifecycleSweepIntervalMs(),
): void {
  if (!isPostgres()) return;
  if (timer) return;

  timer = setInterval(() => {
    void lifecycleSweepOnce();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  console.log(`[v3-lifecycle-sweep] started (interval=${intervalMs}ms)`);
}

/** Stop the lifecycle sweep timer (test cleanup / shutdown). */
export function stopLifecycleSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
