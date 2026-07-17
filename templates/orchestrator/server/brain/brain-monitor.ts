// Brain monitor scheduler — the CONFIGURABLE TIMED/periodic wake (the drift
// backstop) for brain-monitored runs.
//
// The orchestrator brain is a headless `claude -p` session that SLEEPS between
// turns (0 tokens) and is re-invoked via startBrainTurn(). Event-driven wakes
// (node finished / run terminal) handle most of the loop, but a run can stall
// or drift WITHOUT firing an event. This scheduler is the backstop: a durable
// setInterval tick that, for every ACTIVE brain-monitored run (a non-terminal
// v3_runs carrying tags.brainThreadId), wakes the brain every
// monitor_interval_sec to verify the run is on-track — even when no event fired.
//
// Coordination with events: EVERY wake (event / timer / terminal) stamps
// brain_threads.last_wake_at via stampBrainWake(), so an event naturally resets
// the periodic timer and the scheduler never double-fires. The interval is
// resolved per-thread: brain_threads.monitor_interval_sec (NULL → env default
// BRAIN_MONITOR_INTERVAL_SEC, default 120; 0 → disabled / event-only).
//
// Overlap guard: a thread already mid-turn (status = 'running') is SKIPPED — a
// brain that is still actively polling this run must never be re-woken until it
// returns. Modeled on engine/reap.ts (durable, unref-ed setInterval).

import { and, eq, sql } from "drizzle-orm";

import { getManagedClaudeStatus } from "../claude-managed-auth.js";
import { getV3Db, v3Schema } from "../db/index.js";

/** Default periodic drift-check cadence (seconds) when a thread leaves it unset. */
export function defaultMonitorIntervalSec(): number {
  const raw = process.env.BRAIN_MONITOR_INTERVAL_SEC;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 120;
}

/** How often the scheduler sweeps active brain-monitored runs. */
export const MONITOR_TICK_MS = 15_000;

/**
 * The PERIODIC_CHECK message — drift assurance. Instructs the brain to do a
 * quick on-track check of the run it orchestrated and END the turn immediately
 * (no in-place polling). 正常 → confirm + end; 异常 → intervene / replan.
 */
export const PERIODIC_CHECK_MESSAGE =
  "定时巡检:用 runState/v3RunNodes/runSummary 检查你编排的 run 是否在正常推进、有无节点卡死或偏离目标。" +
  "正常→简短确认并结束(继续等待);异常(卡住/跑偏/失败)→用 workflowPatch/nodeRetry/runCancel 介入或重规划。" +
  "不要原地轮询,检查完立即结束回合。";

/**
 * Stamp brain_threads.last_wake_at = now() for a thread. Called by EVERY wake
 * path (event / timer / terminal) so events reset the periodic timer and the
 * scheduler does not double-fire. Best-effort: a stamp failure never blocks the
 * wake itself.
 */
export async function stampBrainWake(threadId: string): Promise<void> {
  try {
    await getV3Db()
      .update(v3Schema.brainThreads)
      .set({ lastWakeAt: new Date(), updatedAt: new Date() })
      .where(eq(v3Schema.brainThreads.id, threadId));
  } catch {
    // Advisory — the wake still happened; a missed stamp only risks one extra
    // (harmless, overlap-guarded) periodic wake.
  }
}

/**
 * Set a thread's periodic drift-check cadence directly (S9 Brain console
 * "监控节奏" card's inline edit — 04 §6). 0 disables the timer (event-only
 * wakes); omitting a call to this leaves the stored value (or the env
 * default) unchanged. Owner-scoped: only the caller's own thread can be
 * updated.
 */
export async function setMonitorIntervalSec(
  threadId: string,
  ownerEmail: string,
  monitorIntervalSec: number,
): Promise<void> {
  await getV3Db()
    .update(v3Schema.brainThreads)
    .set({ monitorIntervalSec, updatedAt: new Date() })
    .where(
      and(
        eq(v3Schema.brainThreads.id, threadId),
        eq(v3Schema.brainThreads.ownerEmail, ownerEmail),
      ),
    );
}

/**
 * One scheduler sweep. For each ACTIVE brain-monitored run (non-terminal
 * v3_runs with tags.brainThreadId), resolve its thread and, when the timer is
 * enabled and due AND the thread is not mid-turn, wake the brain with the
 * PERIODIC_CHECK message and stamp last_wake_at. Returns the thread ids woken
 * (for logging / tests). Best-effort throughout.
 */
export async function monitorSweepOnce(): Promise<string[]> {
  const db = getV3Db();

  // Don't bother (and don't error-spam) when the managed CC login is missing —
  // startBrainTurn would just throw. Event/terminal wakes hit the same guard.
  const login = getManagedClaudeStatus();
  if (!login.loggedIn) return [];

  // Active brain-monitored runs: non-terminal v3_runs whose tags carry a
  // brainThreadId beacon. Join the thread row for interval + last_wake + status.
  // tags is jsonb; `tags->>'brainThreadId'` extracts the beacon text.
  const rows = await db.execute(
    sql`
      SELECT
        t.id                  AS thread_id,
        t.status              AS thread_status,
        t.monitor_interval_sec AS monitor_interval_sec,
        t.last_wake_at        AS last_wake_at,
        t.owner_email         AS owner_email,
        t.org_id              AS org_id
      FROM v3_runs r
      JOIN brain_threads t ON t.id = r.tags->>'brainThreadId'
      WHERE r.status NOT IN ('done', 'failed', 'cancelled')
        AND r.tags->>'brainThreadId' IS NOT NULL
    `,
  );

  const woken: string[] = [];
  const defaultSec = defaultMonitorIntervalSec();
  const now = Date.now();
  // De-dup: a thread may own several active runs — wake it at most once/sweep.
  const seen = new Set<string>();

  for (const row of rows as unknown as Array<Record<string, unknown>>) {
    const threadId = row.thread_id as string;
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);

    // Overlap guard: never re-wake a thread that is still mid-turn.
    if (row.thread_status === "running") continue;

    // Resolve the effective interval: per-thread override → env default.
    const raw = row.monitor_interval_sec;
    const intervalSec =
      raw == null || raw === undefined ? defaultSec : Number(raw);
    // 0 (or negative) → timer disabled; event-only.
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) continue;

    // Due check: now - last_wake_at >= interval. A never-woken thread (no
    // last_wake_at) is due immediately so the first periodic check fires
    // ~interval after dispatch even if no node has finished yet.
    const lastWakeMs = row.last_wake_at
      ? new Date(row.last_wake_at as string).getTime()
      : 0;
    if (now - lastWakeMs < intervalSec * 1000) continue;

    // Wake: stamp FIRST (so a slow startBrainTurn can't let the next sweep
    // double-fire), then re-invoke the brain. startBrainTurn flips the thread to
    // 'running', which the overlap guard above respects on the next sweep.
    try {
      await stampBrainWake(threadId);
      const { startBrainTurn } = await import("./brain-session.js");
      await startBrainTurn({
        threadId,
        ownerEmail: (row.owner_email as string) ?? "local@localhost",
        orgId: (row.org_id as string | null) ?? null,
        message: PERIODIC_CHECK_MESSAGE,
      });
      woken.push(threadId);
    } catch (err) {
      console.warn(
        `[brain-monitor] periodic wake failed for thread ${threadId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return woken;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the durable brain monitor tick. Idempotent — a second call is a no-op.
 * The loop is `unref`-ed so it never blocks process shutdown.
 */
export function startBrainMonitorTick(tickMs: number = MONITOR_TICK_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void monitorSweepOnce().catch((err) => {
      console.warn(
        "[brain-monitor] sweep error:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, tickMs);
  if (typeof timer.unref === "function") timer.unref();
  console.log(
    `[brain-monitor] periodic drift-check scheduler started ` +
      `(tick=${tickMs}ms, default interval=${defaultMonitorIntervalSec()}s)`,
  );
}

/** Stop the brain monitor tick (test cleanup / shutdown). */
export function stopBrainMonitorTick(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
