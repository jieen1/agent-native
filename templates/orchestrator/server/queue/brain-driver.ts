// LEVEL-1 brain-task durable driver. A single server-plugin tick (modeled on
// server/queue/driver.ts) that owns:
//   1. ADMISSION — promote queued brain tasks to running up to the configured
//      degree when slots free (the primary loop besides the synchronous admit on
//      dispatch and the run-terminal release), and
//   2. REAP — release slots stranded by a missed run-terminal release / crashed
//      isolate, then prune orphaned git worktrees.
//
// Living in one durable owner is the point: the run-terminal release (reconciler)
// covers the happy path; this tick is the backstop so a queued task never starves
// when an event is missed. The loop is `unref`-ed so it never blocks shutdown,
// and re-entrancy is guarded so a slow tick never overlaps itself.

import { admitBrainTasks } from "./brain-admit.js";
import { reapBrainTasksOnce, BRAIN_REAP_TICK_MS } from "./brain-reap.js";
import { reconcileBrainThreadsOnce } from "./brain-thread-reconcile.js";
import { reconcileV3SpawnsOnce } from "./v3-spawn-reconcile.js";
import { pruneOrphanedWorktrees } from "../v3-workspace-local.js";

/** Liveness + activity the brain driver tick exposes (read by brain-queue-status). */
export interface BrainDriverHealth {
  driverAlive: boolean;
  lastTickAt: string | null;
  reapsFired: number;
  tasksPromoted: number;
  threadsReconciled: number;
  spawnsReconciled: number;
  lastError: string | null;
}

const health: BrainDriverHealth = {
  driverAlive: false,
  lastTickAt: null,
  reapsFired: 0,
  tasksPromoted: 0,
  threadsReconciled: 0,
  spawnsReconciled: 0,
  lastError: null,
};

/** Read a snapshot of the brain driver's self-observation. */
export function getBrainDriverHealth(): BrainDriverHealth {
  return { ...health };
}

/**
 * One driver tick: reap stranded slots first (so a freed slot is admittable this
 * same tick), then admit queued tasks into any free slots, then prune orphaned
 * worktrees. Idempotent and safe to call manually.
 */
export async function driveBrainOnce(): Promise<{
  reaped: number;
  promoted: number;
  threadsReconciled: number;
  spawnsReconciled: number;
}> {
  const reaped = await reapBrainTasksOnce();
  health.reapsFired += reaped.length;

  // Reset 'running' threads stranded by a process restart / child death so the
  // Brain page never shows a false "运行中" (the THREAD-status counterpart to the
  // brain-task reaper above). Best-effort — never block admission.
  const reconciled = await reconcileBrainThreadsOnce().catch(
    () => [] as Awaited<ReturnType<typeof reconcileBrainThreadsOnce>>,
  );
  health.threadsReconciled += reconciled.length;

  // Reset stranded v3 spawns (running spawn whose parent node/run is terminal or
  // which has no live microVM, plus orphaned pending spawns) so the Resource Pool
  // page never shows a phantom "busy VM" / stale queue. The SPAWN-level
  // counterpart to the brain-thread reconcile above. Best-effort.
  const spawnsReconciled = await reconcileV3SpawnsOnce().catch(
    () => [] as Awaited<ReturnType<typeof reconcileV3SpawnsOnce>>,
  );
  health.spawnsReconciled += spawnsReconciled.length;

  const promoted = await admitBrainTasks();
  health.tasksPromoted += promoted.length;

  // Worktree hygiene — cheap, best-effort.
  await pruneOrphanedWorktrees().catch(() => {});

  health.lastTickAt = new Date().toISOString();
  health.lastError = null;
  return {
    reaped: reaped.length,
    promoted: promoted.length,
    threadsReconciled: reconciled.length,
    spawnsReconciled: spawnsReconciled.length,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Start the durable brain driver tick. Idempotent. `unref`-ed so it never blocks
 * shutdown; re-entrancy guarded. Tick = ~5s (much faster than the reap window):
 * fast enough that a no-run task releases within ~BRAIN_NORUN_RELEASE_GRACE_SEC
 * + one tick (≈30s) and the freed slot is admitted the SAME tick (reap → admit).
 */
export function startBrainDriver(opts: { tickMs?: number } = {}): void {
  if (timer) return;
  const tickMs = opts.tickMs ?? 5_000;
  health.driverAlive = true;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void driveBrainOnce()
      .catch((err: unknown) => {
        health.lastError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        ticking = false;
      });
  }, tickMs);
  if (typeof timer.unref === "function") timer.unref();
  console.log(
    `[brain-driver] brain-task admission/reap driver started (tick=${tickMs}ms, ` +
      `reap window=${BRAIN_REAP_TICK_MS}ms)`,
  );
  // Run one tick immediately on startup so a thread/task stranded 'running' by the
  // restart that just happened is reconciled at once (not only after the first
  // interval). Best-effort; the interval is the steady-state path.
  void driveBrainOnce().catch((err: unknown) => {
    health.lastError = err instanceof Error ? err.message : String(err);
  });
}

/** Stop the brain driver tick (test cleanup / shutdown). */
export function stopBrainDriver(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  health.driverAlive = false;
}
