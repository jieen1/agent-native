// Brain THREAD reconciler — the missing counterpart to the brain-task reaper.
//
// brain_threads.status flips to 'running' on every turn start (brain-session.ts
// startBrainTurn) and is flipped back to 'done'/'error' by finalizeThreadStatus
// ONLY when the in-process `runBrainChild` background promise runs to completion.
// If the orchestrator process is killed/restarted mid-turn (redeploy, crash,
// OOM), or the `claude` child dies without the finalizer running, that in-memory
// promise is lost and the thread is STRANDED at 'running' forever — the Brain
// page then shows a false "运行中" with no live work behind it. The brain-task
// reaper (brain-reap.ts) closes the mirror gap (stranded TASK whose THREAD is
// terminal) but never resets a stranded THREAD, so nothing recovers this state.
//
// This sweep is that recovery. It resets a 'running' thread to a terminal status
// when there is demonstrably no live brain child driving it, judged by ACTIVITY
// RECENCY rather than the status flag itself:
//
//   • A live `claude -p` child streams events continuously into brain_events
//     (assistant / tool_use / tool_result), so the freshest signal of liveness is
//     GREATEST(thread.updated_at, latest brain_event.created_at). updated_at alone
//     is insufficient — appendEvent does NOT bump it, so a long single turn can
//     have a stale updated_at while genuinely alive; the event stream is the
//     authoritative heartbeat.
//   • Only when that freshest activity is older than a GENEROUS grace window
//     (BRAIN_THREAD_STALE_GRACE_MS, default 15 min — longer than any real brain
//     turn and longer than the 10-min brain-task hard backstop) do we treat the
//     thread as orphaned. This guarantees a genuinely-running thread (streaming or
//     recently woken) is NEVER reset.
//
// Disposition mirrors finalizeThreadStatus (the normal-completion writer): a
// thread whose most recent bound brain_task is failed/cancelled settles to
// 'error'; otherwise 'done' (the same default a clean run-to-completion gives).
// A clear error message records that this was a reconcile, not a real failure.

import { getDbExec } from "../db/index.js";
import { isPostgres } from "@agent-native/core/db";

/**
 * A 'running' brain thread is eligible for reconcile only after this long with no
 * fresh activity (no turn start AND no streamed event). Generous by design so a
 * real long brain turn — which streams events as it works — never trips it; the
 * primary status writer is the in-process finalizeThreadStatus, this is the
 * crash/restart backstop. Env-overridable via BRAIN_THREAD_STALE_GRACE_MS.
 */
export const BRAIN_THREAD_STALE_GRACE_MS = (() => {
  const raw = Number(process.env.BRAIN_THREAD_STALE_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000; // 15 min default
})();

/** A reconciled (reset) brain thread, for caller observability. */
export interface ReconciledBrainThread {
  id: string;
  from: string;
  to: string;
  reason: string;
}

/**
 * One brain-thread reconcile sweep. Resets each 'running' thread whose freshest
 * activity (GREATEST(updated_at, latest event created_at)) is older than the
 * grace window — i.e. no live brain child is driving it — to a terminal status:
 * 'error' when its most recent bound brain_task is failed/cancelled, else 'done'.
 *
 * Best-effort: never throws into the driver tick. Returns the reconciled threads.
 */
export async function reconcileBrainThreadsOnce(
  graceMs: number = BRAIN_THREAD_STALE_GRACE_MS,
): Promise<ReconciledBrainThread[]> {
  if (!isPostgres()) return [];

  const cutoffIso = new Date(Date.now() - graceMs).toISOString();
  const reconciled: ReconciledBrainThread[] = [];

  // Candidate 'running' threads whose freshest activity is older than the grace.
  // Liveness = GREATEST(thread.updated_at, latest brain_event.created_at): a live
  // child streams events, so a stale max means no child is driving the thread.
  // last_task_status = the most recently updated bound brain_task's status, used
  // to decide done vs error (mirrors finalizeThreadStatus).
  const candidates = await getDbExec().execute(
    `SELECT
        t.id AS id,
        GREATEST(
          COALESCE(t.updated_at, 'epoch'::timestamptz),
          COALESCE((SELECT max(e.created_at) FROM brain_events e
                     WHERE e.thread_id = t.id), 'epoch'::timestamptz)
        ) AS last_activity,
        (SELECT bt.status FROM brain_tasks bt
          WHERE bt.thread_id = t.id
          ORDER BY bt.updated_at DESC NULLS LAST
          LIMIT 1) AS last_task_status
       FROM brain_threads t
      WHERE t.status = 'running'`,
  );

  for (const row of candidates.rows as Array<Record<string, unknown>>) {
    const id = String(row.id);
    const lastActivity = row.last_activity
      ? new Date(String(row.last_activity)).getTime()
      : 0;
    // Live or recently active → leave it alone (never reset a real running turn).
    if (lastActivity > Date.now() - graceMs) continue;

    const lastTaskStatus =
      row.last_task_status == null ? null : String(row.last_task_status);
    const errored =
      lastTaskStatus === "failed" || lastTaskStatus === "cancelled";
    const to = errored ? "error" : "done";
    const ageMin = Math.round((Date.now() - lastActivity) / 60_000);
    const reason = errored
      ? `reconciled: stranded running thread (no live child for ~${ageMin}m; last task ${lastTaskStatus})`
      : `reconciled: stranded running thread (no live child for ~${ageMin}m)`;

    // Guard the write on status='running' AND the stale cutoff so we never race a
    // thread that just got woken (its updated_at would have moved past cutoff).
    const errorText = errored
      ? `Reset by thread reconcile: the brain turn ended without finalizing ` +
        `(process restart or child death). Last task ${lastTaskStatus}.`
      : null;
    const upd = await getDbExec().execute({
      sql: `UPDATE brain_threads
          SET status = $2,
              error = $3,
              updated_at = now()
        WHERE id = $1
          AND status = 'running'
          AND GREATEST(
                COALESCE(updated_at, 'epoch'::timestamptz),
                COALESCE((SELECT max(e.created_at) FROM brain_events e
                           WHERE e.thread_id = brain_threads.id),
                         'epoch'::timestamptz)
              ) < $4
        RETURNING id`,
      args: [id, to, errorText, cutoffIso],
    });
    if ((upd.rows?.length ?? 0) > 0) {
      reconciled.push({ id, from: "running", to, reason });
    }
  }

  if (reconciled.length > 0) {
    console.warn(
      `[brain-thread-reconcile] reset ${reconciled.length} stranded running ` +
        `thread(s): ${reconciled.map((r) => `${r.id}→${r.to}`).join(", ")}`,
    );
  }

  return reconciled;
}
