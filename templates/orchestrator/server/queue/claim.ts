// Atomic single-flight claim of the next queued work item (DESIGN §6.4 / §13).
//
// This is a verbatim copy of the proven framework pattern
// `claimA2ATaskForProcessing` (a2a/task-store.ts): an UPDATE…WHERE guarded by
// the current state, then `getAffectedRowCount`, and ONLY on a non-zero count a
// SEPARATE SELECT of the claimed row. There is deliberately NO `RETURNING` —
// the framework portability rule forbids `RETURNING` in shared app code
// (portability/SKILL.md), and the cited primitive uses the affected-rows+SELECT
// form so the same code runs unchanged on SQLite (@libsql) and Postgres.
//
// Single-flight: the WHERE clause re-asserts `exec_state='queued'` on the SAME
// row the subquery picked, so two workers racing for the same row resolve to
// exactly one winner (rowsAffected 1 for the winner, 0 for the loser). The
// subquery does the priority ordering (`ORDER BY priority, id` — `id` is the
// deterministic tiebreaker); the outer UPDATE locates that single row by id and
// re-checks its state. We never use `UPDATE … ORDER BY … LIMIT` (non-portable).

import { getDbExec } from "../db/index.js";
import { newId } from "../../actions/_util.js";

/** A claimed work-item row (only the queue-relevant columns). */
export interface ClaimedWorkItem {
  id: string;
  projectId: string;
  priority: number;
  workflowId: string | null;
  execState: string;
  /**
   * The UNIQUE claim token written to `claimed_by` for THIS claim attempt
   * (worker id + a fresh unique suffix). The caller passes this exact token to
   * markRunning / settle so the guarded follow-up updates match only this row —
   * it is what makes the separate post-claim SELECT unambiguous even when one
   * worker claims two rows in the same millisecond (a bare timestamp can alias).
   */
  claimToken: string;
  /** The worker that owns this claim (the token's prefix). */
  workerId: string;
  claimedAt: string;
}

/**
 * Read `rowsAffected` from a raw db-exec result, tolerant of the libsql /
 * Postgres / D1 shapes (identical to the framework's private getAffectedRowCount).
 */
function affectedRows(result: unknown): number {
  const r = result as {
    rowsAffected?: number;
    rowCount?: number;
    count?: number;
  };
  return r?.rowsAffected ?? r?.rowCount ?? r?.count ?? 0;
}

/**
 * Atomically claim the single highest-priority queued work item for `workerId`.
 * Returns the claimed row, or null when nothing is claimable (queue empty or the
 * raced row was grabbed by another worker first).
 *
 * Steps (copying claimA2ATaskForProcessing exactly):
 *  1. UPDATE work_items SET exec_state='claimed', claimed_by=?, claimed_at=?
 *       WHERE id = (SELECT id FROM work_items WHERE exec_state='queued'
 *                   ORDER BY priority, id LIMIT 1)
 *         AND exec_state='queued'
 *  2. affected = getAffectedRowCount(result); if affected === 0 → null
 *  3. SELECT the claimed row (a SEPARATE select, NOT RETURNING).
 */
export async function claimNextWorkItem(
  workerId: string,
): Promise<ClaimedWorkItem | null> {
  const client = getDbExec();
  const now = new Date().toISOString();
  // A unique token per claim ATTEMPT (worker id + fresh suffix). Written to
  // claimed_by, then matched exactly by the follow-up SELECT — so the SELECT can
  // never alias to a different row this same worker claimed earlier (which a
  // bare workerId+timestamp can, on a same-millisecond double claim).
  const claimToken = `${workerId}::${newId("c")}`;

  const result = await client.execute({
    sql: `UPDATE work_items
            SET exec_state = 'claimed',
                claimed_by = ?,
                claimed_at = ?,
                updated_at = ?
          WHERE id = (
                  SELECT id FROM work_items
                   WHERE exec_state = 'queued'
                   ORDER BY priority, id
                   LIMIT 1
                )
            AND exec_state = 'queued'`,
    args: [claimToken, now, now],
  });

  if (affectedRows(result) === 0) return null;

  // Separate SELECT of the row this attempt claimed (NOT RETURNING). The unique
  // claim token makes this exact: only the single row this attempt won carries
  // it, and a claimed row is never re-claimed.
  const { rows } = await client.execute({
    sql: `SELECT id, project_id, priority, workflow_id, exec_state, claimed_by, claimed_at
            FROM work_items
           WHERE claimed_by = ?
             AND exec_state = 'claimed'
           LIMIT 1`,
    args: [claimToken],
  });
  const row = rows[0];
  if (!row) return null;

  return {
    id: String(row.id),
    projectId: String(row.project_id),
    priority: Number(row.priority ?? 0),
    workflowId: (row.workflow_id as string | null) ?? null,
    execState: String(row.exec_state),
    claimToken,
    workerId,
    claimedAt: String(row.claimed_at),
  };
}

/**
 * Mark a claimed item as actually `running` (claimed → running). Guarded on the
 * claim TOKEN so a row reaped back to `queued` (and re-claimed by someone else)
 * between claim and run-start is NOT silently resurrected — the update only
 * fires while the row is still claimed under THIS token. Refreshes claimed_at
 * (the heartbeat). Returns true when the row moved to running.
 */
export async function markRunning(
  itemId: string,
  claimToken: string,
  workflowRunId: string,
): Promise<boolean> {
  const client = getDbExec();
  const now = new Date().toISOString();
  const result = await client.execute({
    sql: `UPDATE work_items
            SET exec_state = 'running',
                workflow_run_id = ?,
                claimed_at = ?,
                updated_at = ?
          WHERE id = ?
            AND claimed_by = ?
            AND exec_state = 'claimed'`,
    args: [workflowRunId, now, now, itemId, claimToken],
  });
  return affectedRows(result) > 0;
}

/**
 * Settle a running item to a terminal execState (running → done|failed). Guarded
 * on the running state so a reaped/cancelled row is not overwritten. Returns
 * true when the row settled. Business `status` is untouched (§6.4) — the agent's
 * transition-work-item owns that.
 */
export async function settleWorkItem(
  itemId: string,
  to: "done" | "failed",
): Promise<boolean> {
  const client = getDbExec();
  const now = new Date().toISOString();
  const result = await client.execute({
    sql: `UPDATE work_items
            SET exec_state = ?,
                updated_at = ?
          WHERE id = ?
            AND exec_state IN ('running', 'claimed')`,
    args: [to, now, itemId],
  });
  return affectedRows(result) > 0;
}

/**
 * Hand a CLAIMED item off to the brain (claimed → paused) instead of running it.
 * Used when decomposition resolved the DYNAMIC path (DESIGN §6.3 order 3): the
 * worker pool cannot execute a placeholder run, so it parks the item `paused` for
 * the orchestrating agent to author + run the DAG. Guarded on claimed/running so
 * a reaped row is not overwritten. Business `status` is untouched (§6.4).
 */
export async function releaseToBrain(itemId: string): Promise<boolean> {
  const client = getDbExec();
  const now = new Date().toISOString();
  const result = await client.execute({
    sql: `UPDATE work_items
            SET exec_state = 'paused',
                updated_at = ?
          WHERE id = ?
            AND exec_state IN ('claimed', 'running')`,
    args: [now, itemId],
  });
  return affectedRows(result) > 0;
}

export { affectedRows };
