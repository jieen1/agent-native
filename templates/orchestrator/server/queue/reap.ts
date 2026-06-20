// Work-item queue heartbeat / reap (DESIGN §6.4 D-3 / §13). A worker that dies
// mid-flight leaves its item wedged at `claimed` or `running` with a stale
// `claimed_at`. The durable tick periodically returns any such stranded item
// back to `queued` so another worker re-claims it (single-flight still holds —
// it goes through the same atomic claim). A FRESH claim (claimed_at newer than
// the cutoff) is NOT reaped — that worker is still alive.
//
// `claimed_at` doubles as the heartbeat: the atomic claim sets it, markRunning
// refreshes it. The threshold is an EXPLICIT constant so the tick and the tests
// agree on one value; the clock read here is liveness-only (recovery), never a
// scheduling decision (§0.2.1).

import { getDbExec } from "../db/index.js";
import { affectedRows } from "./claim.js";

/**
 * How long a claimed/running work item may go without refreshing `claimed_at`
 * before the reaper returns it to the queue. 120s comfortably exceeds a normal
 * run's claim→start gap while recovering a crashed worker within ~2 ticks.
 */
export const WORK_ITEM_REAP_THRESHOLD_MS = 120_000;

/** How often the durable tick runs the queue reap sweep. */
export const QUEUE_REAP_TICK_MS = 60_000;

/** A reaped (re-queued) work item, for caller observability. */
export interface ReapedWorkItem {
  id: string;
  fromState: string;
  claimedBy: string | null;
  claimedAt: string | null;
}

/**
 * One queue reap sweep. Return every `claimed`/`running` work item whose
 * `claimed_at` is strictly older than `cutoffIso` (or null = never beat) to
 * `queued`, clearing claimed_by/claimed_at so the next atomic claim is clean. A
 * row with a FRESH claimed_at (>= cutoff) is left alone. Returns the reaped rows.
 *
 * Implemented as: SELECT the candidates, then a guarded UPDATE per row (the
 * guard re-checks the same stale state + claimed_at so a row that started
 * beating between the select and the update is not clobbered). No RETURNING.
 */
export async function reapStrandedWorkItems(
  cutoffIso: string,
): Promise<ReapedWorkItem[]> {
  const client = getDbExec();
  const { rows } = await client.execute({
    sql: `SELECT id, exec_state, claimed_by, claimed_at
            FROM work_items
           WHERE exec_state IN ('claimed', 'running')
             AND (claimed_at IS NULL OR claimed_at < ?)`,
    args: [cutoffIso],
  });

  const now = new Date().toISOString();
  const reaped: ReapedWorkItem[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const fromState = String(row.exec_state);
    const claimedAt = (row.claimed_at as string | null) ?? null;
    // Guarded re-queue: only fire while the row is STILL in the same stranded
    // state with the SAME stale claimed_at (NULL-safe). If a fresh claim/run
    // landed in between, the guard fails and we skip it.
    const result = await client.execute({
      sql: `UPDATE work_items
              SET exec_state = 'queued',
                  claimed_by = NULL,
                  claimed_at = NULL,
                  workflow_run_id = NULL,
                  updated_at = ?
            WHERE id = ?
              AND exec_state = ?
              AND ((claimed_at IS NULL AND ? IS NULL) OR claimed_at = ?)`,
      args: [now, id, fromState, claimedAt, claimedAt],
    });
    if (affectedRows(result) > 0) {
      reaped.push({
        id,
        fromState,
        claimedBy: (row.claimed_by as string | null) ?? null,
        claimedAt,
      });
    }
  }
  return reaped;
}

/**
 * Compute the cutoff from the explicit threshold and reap. Returns the reaped
 * rows. The single clock read is recovery-only.
 */
export async function reapQueueOnce(
  thresholdMs: number = WORK_ITEM_REAP_THRESHOLD_MS,
): Promise<ReapedWorkItem[]> {
  const cutoffIso = new Date(Date.now() - thresholdMs).toISOString();
  return reapStrandedWorkItems(cutoffIso);
}
