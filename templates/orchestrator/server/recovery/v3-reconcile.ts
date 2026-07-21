// V3 startup recovery (DESIGN §9 "Restart safety", G2).
//
// On startup the V3 reconciler's in-memory state is gone.  Any v3_run left in
// `pending`, `running`, or `paused` status may have stranded `running` nodes
// (no live dispatcher is advancing them).  This module mirrors the V2 path in
// `reconcile.ts` as a SEPARATE path so the V2 recovery is never modified.
//
//   (a) Scan v3_runs with status IN ('pending','running','paused').
//   (b) For each: reset every v3_nodes row still at `running` to `pending`
//       (the dispatcher is gone — "stranded running" = must re-dispatch).
//   (c) Re-tick each run so the reconciler picks up from current state.
//
// Idempotent: a second call with no stranded rows is a no-op.
// Best-effort: errors must not block boot (caller catches and logs).

import { eq, inArray } from "drizzle-orm";

import { getV3Db } from "../db/index.js";
import { v3Runs, v3Nodes } from "../db/v3-schema.js";
import { triggerTickSafe } from "../plugins/v3-reconciler.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** A v3_nodes row that was stranded `running` and reset to `pending`. */
export interface V3ResetNode {
  id: string;
  runId: string;
  nodeIdInDag: string;
}

/** Summary of one v3_run recovered on startup. */
export interface V3RecoveredRun {
  runId: string;
  /** Nodes reset from `running` → `pending` for re-dispatch. */
  resetNodes: V3ResetNode[];
}

export interface V3ReconcileStartupResult {
  /** Runs found in active states and re-ticked. */
  recoveredRuns: V3RecoveredRun[];
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Reset any v3_nodes still at `running` for the given run.
 *
 * On a cold restart there is no live dispatcher — every `running` node is
 * stranded.  We reset them to `pending` so the reconciler re-dispatches them
 * on the next tick (same single-isolate assumption as the V2 path).
 */
async function resetStrandedV3Nodes(runId: string): Promise<V3ResetNode[]> {
  const db = getV3Db();

  const rows = await db
    .select({
      id: v3Nodes.id,
      runId: v3Nodes.runId,
      nodeIdInDag: v3Nodes.nodeIdInDag,
      status: v3Nodes.status,
    })
    .from(v3Nodes)
    .where(eq(v3Nodes.runId, runId));

  const reset: V3ResetNode[] = [];

  for (const row of rows) {
    if (row.status !== "running") continue;

    // Reset to pending so the next tick re-dispatches this node.
    await db
      .update(v3Nodes)
      .set({
        status: "pending",
        error: null,
        currentSpawnId: null,
        startedAt: null,
        completedAt: null,
      })
      .where(eq(v3Nodes.id, row.id));

    reset.push({
      id: row.id,
      runId: row.runId,
      nodeIdInDag: row.nodeIdInDag,
    });
  }

  return reset;
}

/**
 * V3 startup reconciliation (G2).
 *
 * Scans v3_runs in (pending, running, paused), resets stranded running nodes,
 * and re-ticks each run.  Runs as a separate path from the V2 reconcile so
 * neither path interferes with the other.
 *
 * This function is best-effort: errors from individual runs are caught and
 * logged; a failed run does not block recovery of subsequent runs.
 */
export async function reconcileV3OnStartup(): Promise<V3ReconcileStartupResult> {
  const db = getV3Db();

  // Scan active V3 runs: pending + running + paused all need a reconciler tick.
  const activeRuns = await db
    .select({
      id: v3Runs.id,
      status: v3Runs.status,
    })
    .from(v3Runs)
    .where(inArray(v3Runs.status, ["pending", "running", "paused"]));

  const recoveredRuns: V3RecoveredRun[] = [];

  for (const run of activeRuns) {
    try {
      // (b) Reset stranded running nodes for this run.
      const resetNodes = await resetStrandedV3Nodes(run.id);

      // (c) Re-tick so the reconciler picks up from current state.
      // triggerTickSafe never throws — errors are swallowed inside.
      await triggerTickSafe(run.id);

      recoveredRuns.push({
        runId: run.id,
        resetNodes,
      });
    } catch (err) {
      // One run failing must not block the rest.
      console.warn(
        `[v3-reconcile-startup] failed to recover run ${run.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { recoveredRuns };
}
