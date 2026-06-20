// ===========================================================================
// finalize-status GATE — RUNTIME assertion (DESIGN §6.2b layer 1 / §3.7).
//
// The STRUCTURAL half (shared/finalize-gate.ts) guarantees a `finalize-status`
// node sits right before `end`. THIS is what that node DOES when the scheduler
// reaches it: it resolves the run's bound work item + the project's per-type
// scheme and asserts the agent moved the item to a SENSIBLE near-terminal /
// terminal business status before the run can succeed. If the item is still
// parked in an early stage (the agent never called transition-work-item to a
// ≥ near-terminal stage), the gate FAILS — the node is `failed`, the run fails.
//
// "Near-terminal" (DESIGN §6.2b "an item rests at 待发布 by design"):
//   • the LAST in-progress stage of the type's scheme (the 待发布/待验收-equivalent
//     the agent reaches when it opens the PR / produces the artifact), OR
//   • any completed/cancelled stage (a human/webhook already shipped/closed it).
// Anything earlier (todo, or a mid in-progress stage) is NOT a finalized run.
//
// A run with NO bound work item is EXEMPT — there is no business status to
// finalize (the P1/P2 fixture runs, DESIGN §0.6). The gate passes silently.
// ===========================================================================

import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { schemeForType } from "./schemes.js";
import {
  categoryOf,
  stageIndex,
  type StatusScheme,
} from "../../shared/status-schemes.js";

/** The outcome of a finalize-status check, for the gate executor + tests. */
export interface FinalizeCheckResult {
  /** True when the gate PASSES (status finalized or run is exempt). */
  ok: boolean;
  /** True when the run had no bound work item (exempt — passes). */
  exempt: boolean;
  /** The bound work item id, or null when exempt. */
  workItemId: string | null;
  /** The work item's current business status, or null when exempt. */
  status: string | null;
  /** A human-readable reason the gate failed (when !ok). */
  reason?: string;
}

/**
 * The index of the type's last in-progress stage = the near-terminal threshold.
 * A status whose index ≥ this (or whose category is completed/cancelled) counts
 * as finalized. Returns -1 when the scheme has no in-progress stage.
 */
function nearTerminalIndex(scheme: StatusScheme): number {
  let idx = -1;
  scheme.stages.forEach((s, i) => {
    if (s.category === "in-progress") idx = i;
  });
  return idx;
}

/** True when `status` is a finalized (near-terminal or terminal) stage. */
export function isFinalizedStatus(
  scheme: StatusScheme,
  status: string,
): boolean {
  const cat = categoryOf(scheme, status);
  if (cat === "completed" || cat === "cancelled") return true;
  const si = stageIndex(scheme, status);
  if (si < 0) return false;
  const threshold = nearTerminalIndex(scheme);
  return threshold >= 0 && si >= threshold;
}

/**
 * Check the finalize-status gate for a run. Pure DB read (no writes): resolves
 * the run → work item → project scheme and asserts the item reached a finalized
 * status. The gate executor (scheduler seam) throws on `!ok` so the node fails.
 *
 * @param runId the workflow_run reaching its finalize-status node.
 */
export async function checkFinalizeStatus(
  runId: string,
): Promise<FinalizeCheckResult> {
  const db = getDb();
  const runRows = await db
    .select({ workItemId: schema.workflowRuns.workItemId })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .limit(1);
  const run = runRows[0];

  // No run row, or no bound work item → exempt (nothing to finalize).
  if (!run || !run.workItemId) {
    return { ok: true, exempt: true, workItemId: null, status: null };
  }

  const itemRows = await db
    .select({
      type: schema.workItems.type,
      status: schema.workItems.status,
      projectId: schema.workItems.projectId,
    })
    .from(schema.workItems)
    .where(eq(schema.workItems.id, run.workItemId))
    .limit(1);
  const item = itemRows[0];
  if (!item) {
    // The bound item vanished — treat as exempt rather than wedging the run.
    return {
      ok: true,
      exempt: true,
      workItemId: run.workItemId,
      status: null,
    };
  }

  const projRows = await db
    .select({ statusSchemes: schema.projects.statusSchemes })
    .from(schema.projects)
    .where(eq(schema.projects.id, item.projectId))
    .limit(1);
  const scheme = schemeForType(
    projRows[0]?.statusSchemes ?? null,
    String(item.type),
  );

  const status = String(item.status ?? "");
  if (isFinalizedStatus(scheme, status)) {
    return {
      ok: true,
      exempt: false,
      workItemId: run.workItemId,
      status,
    };
  }

  return {
    ok: false,
    exempt: false,
    workItemId: run.workItemId,
    status,
    reason:
      `finalize-status gate: work item ${run.workItemId} is still at '${status || "(unset)"}' — ` +
      `the agent must call transition-work-item to a near-terminal stage ` +
      `(e.g. 待发布) before the run can finish.`,
  };
}
