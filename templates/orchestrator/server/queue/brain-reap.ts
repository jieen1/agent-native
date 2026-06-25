// LEVEL-1 brain-task reaper — releases slots that the run-terminal hook missed,
// and clears wedged tasks so admission can keep flowing. Mirrors
// server/queue/reap.ts in spirit (a durable liveness sweep), but targets the
// brain task queue (Postgres) rather than the v2 work-item queue.
//
// A running brain_task occupies a slot from admission until its bound run goes
// terminal (the reconciler run-terminal wake releases it). Two gaps this reaper
// closes:
//
//   1. The release was missed (the run went terminal but the wake's release did
//      not fire — e.g. a redeploy between terminal and wake, or a task whose
//      brain finished WITHOUT ever creating a run). Detect via the brain THREAD:
//      a brain_task whose thread is `error`/`done` AND whose claimed_at is older
//      than the liveness cutoff is released so the slot is reclaimed.
//
//   2. A task wedged at `running` for far longer than any brain turn could last
//      with no progress (claimed_at very old) — released defensively so a crashed
//      isolate never strands a slot forever.
//
// Liveness, not scheduling: the clock read here is recovery-only. Release keys on
// the bound run / thread terminal state and an age cutoff, NEVER on the live
// thread status alone (which flips to 'running' on every wake — see
// brain-monitor.ts / the reconciler wake paths).

import { v3DbExec, isV3PostgresConfigured } from "../db/v3.js";

/** How often the brain driver tick runs the reap sweep. */
export const BRAIN_REAP_TICK_MS = 30_000;

/**
 * A running brain_task is eligible for reaper release only after this long with
 * no fresh claim. Generous so a normal brain turn + its run never trips it; the
 * primary release path is the run-terminal wake, this is the backstop.
 *
 * Env-overridable via BRAIN_TASK_REAP_THRESHOLD_MS. When a brain completes work
 * directly (commit + PR via Bash/Edit) WITHOUT a bound v3 run, there is no
 * run-terminal wake to release the slot — the reaper is the only release path,
 * so a shorter threshold lets queued tasks promote promptly once the thread goes
 * done/idle. Defaults to 10 min.
 */
export const BRAIN_TASK_REAP_THRESHOLD_MS = (() => {
  const raw = Number(process.env.BRAIN_TASK_REAP_THRESHOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000; // 10 min default
})();

/** A reaped (released) brain task, for caller observability. */
export interface ReapedBrainTask {
  id: string;
  threadId: string;
  reason: string;
}

/**
 * One brain-task reap sweep. Releases running tasks whose slot was stranded:
 *
 *  (a) the bound brain thread is terminal-failed/idle/done but the task is still
 *      `running` past the liveness cutoff — the run-terminal release was missed
 *      or the brain finished without ever binding a run; release as `done`
 *      (or `failed` when the thread errored), and
 *  (b) any running task whose claimed_at is older than the hard reap threshold —
 *      a crashed isolate; release as `failed`.
 *
 * Returns the released tasks. Best-effort: never throws into the tick. After a
 * release, admission is re-run so the freed slot is filled.
 */
export async function reapBrainTasksOnce(
  thresholdMs: number = BRAIN_TASK_REAP_THRESHOLD_MS,
): Promise<ReapedBrainTask[]> {
  if (!isV3PostgresConfigured()) return [];

  const cutoffIso = new Date(Date.now() - thresholdMs).toISOString();
  const reaped: ReapedBrainTask[] = [];

  // (a) Thread-terminal but task still running past the cutoff. A brain thread
  // status of 'error' / 'done' / 'idle' means no live `claude` child is driving
  // it; if the task is still `running` and not freshly claimed, the slot leaked.
  // We require the age cutoff so we never race a thread that just flipped to a
  // transient non-running status mid-wake.
  const threadDeadRes = await v3DbExec(
    `SELECT bt.id AS id, bt.thread_id AS thread_id, btr.status AS thread_status
       FROM brain_tasks bt
       JOIN brain_threads btr ON btr.id = bt.thread_id
      WHERE bt.status = 'running'
        AND btr.status IN ('error', 'done', 'idle')
        AND (bt.claimed_at IS NULL OR bt.claimed_at < $1)`,
    [cutoffIso],
  );

  for (const row of threadDeadRes.rows as Array<Record<string, unknown>>) {
    const id = String(row.id);
    const threadId = String(row.thread_id);
    const threadStatus = String(row.thread_status);
    const terminal = threadStatus === "error" ? "failed" : "done";
    const upd = await v3DbExec(
      `UPDATE brain_tasks SET status = $2, updated_at = now()
         WHERE id = $1 AND status = 'running' RETURNING id`,
      [id, terminal],
    );
    if ((upd.rows?.length ?? 0) > 0) {
      reaped.push({ id, threadId, reason: `thread ${threadStatus}` });
    }
  }

  // (b) Hard age cutoff: any running task whose claimed_at is older than the
  // threshold, regardless of thread status — a crashed isolate that left a wedge.
  const staleRes = await v3DbExec(
    `SELECT id, thread_id FROM brain_tasks
      WHERE status = 'running'
        AND (claimed_at IS NULL OR claimed_at < $1)`,
    [cutoffIso],
  );
  for (const row of staleRes.rows as Array<Record<string, unknown>>) {
    const id = String(row.id);
    const threadId = String(row.thread_id);
    if (reaped.some((r) => r.id === id)) continue;
    const upd = await v3DbExec(
      `UPDATE brain_tasks SET status = 'failed', updated_at = now()
         WHERE id = $1 AND status = 'running' RETURNING id`,
      [id],
    );
    if ((upd.rows?.length ?? 0) > 0) {
      reaped.push({ id, threadId, reason: "stale (>threshold)" });
    }
  }

  return reaped;
}
