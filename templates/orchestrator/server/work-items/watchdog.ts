// Reconciliation watchdog (DESIGN §6.2b layer 2 — the HARD guarantee). When a
// workflow_run that is bound to a work item reaches a terminal status, this
// checks the status-activity log: did business `status` actually change during
// this run? If NOT, it flags work_items.status_stale = true so the board can
// surface "AI finished — status not updated, confirm". A finished run can never
// silently leave status stale; it is either updated by the agent or flagged.
//
// A run with NO work_item is explicitly EXEMPT (DESIGN §0.6: "无 workItemId 的 run
// 跳过 watchdog"). This is wired minimally into the engine run-finalize so any
// run that has a work_item triggers it, and is exposed headlessly via the
// `reconcile-on-terminal` action.

import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { nowIso } from "../../actions/_util.js";

export interface ReconcileResult {
  /** The run that was checked. */
  runId: string;
  /** The bound work item, or null when the run has none (then it's skipped). */
  workItemId: string | null;
  /** True when the watchdog ran (run had a work item AND was terminal). */
  checked: boolean;
  /** True when at least one real status change was logged during this run. */
  statusChanged: boolean;
  /** True when status_stale was newly set (checked && !statusChanged). */
  flaggedStale: boolean;
}

const TERMINAL_RUN_STATUSES = new Set(["done", "failed"]);

/**
 * Reconcile a single run on its terminal transition (DESIGN §6.2b L2). Idempotent:
 * re-running on an already-flagged item leaves it flagged. Pure DB; no IO.
 *
 * @param runId the workflow_run that just reached a terminal status.
 */
export async function reconcileOnTerminal(
  runId: string,
): Promise<ReconcileResult> {
  const db = getDb();
  const runRows = await db
    .select({
      id: schema.workflowRuns.id,
      workItemId: schema.workflowRuns.workItemId,
      status: schema.workflowRuns.status,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .limit(1);
  const run = runRows[0];
  if (!run) {
    return {
      runId,
      workItemId: null,
      checked: false,
      statusChanged: false,
      flaggedStale: false,
    };
  }

  // EXEMPT: a run with no bound work item has no business status to reconcile.
  if (!run.workItemId) {
    return {
      runId,
      workItemId: null,
      checked: false,
      statusChanged: false,
      flaggedStale: false,
    };
  }

  // Only reconcile when the run is actually terminal (done/failed). A paused or
  // running run is not yet a candidate.
  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    return {
      runId,
      workItemId: run.workItemId,
      checked: false,
      statusChanged: false,
      flaggedStale: false,
    };
  }

  // Did business `status` change during THIS run? = a status-log row exists for
  // this run_id where from_status != to_status (a real stage move, not a pure
  // blocked-flag write where from == to).
  const changedRows = await db
    .select({ id: schema.workItemStatusLog.id })
    .from(schema.workItemStatusLog)
    .where(
      and(
        eq(schema.workItemStatusLog.runId, runId),
        ne(
          schema.workItemStatusLog.fromStatus,
          schema.workItemStatusLog.toStatus,
        ),
      ),
    )
    .limit(1);
  const statusChanged = changedRows.length > 0;

  if (statusChanged) {
    return {
      runId,
      workItemId: run.workItemId,
      checked: true,
      statusChanged: true,
      flaggedStale: false,
    };
  }

  // No status change during the run → flag stale (idempotent set to 1).
  await db
    .update(schema.workItems)
    .set({ statusStale: 1, updatedAt: nowIso() })
    .where(eq(schema.workItems.id, run.workItemId));

  return {
    runId,
    workItemId: run.workItemId,
    checked: true,
    statusChanged: false,
    flaggedStale: true,
  };
}
