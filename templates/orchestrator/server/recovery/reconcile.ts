// DURABLE RUN STORE — crash recovery on startup (DESIGN §14 / §1.7). The
// scheduler's in-memory `startRun` state is per-isolate: a crash or redeploy
// leaves rows wedged at `running` with no live driver. This module is the single
// durable owner that RECONCILES that state when the process comes back up:
//
//   (a) A workflow_run left `running` with a mix of done + running NodeRuns is
//       RE-DRIVEN. Per §1.7 the journal replay is exact: done NodeRuns are NOT
//       re-run (their journaled artifacts replay at zero token cost; attempts
//       unchanged); a STRANDED `running` NodeRun is reset to `pending` so resume
//       re-runs it (and its divergent tail) atomically from a clean slate.
//   (b) A work_item left `claimed`/`running` past the heartbeat threshold is
//       returned to `queued` by the queue reap, so EXACTLY ONE worker re-claims
//       it through the atomic claim (no two active workflow_runs for one item).
//   (c) Every reaped/re-driven row leaves a TRAIL — an audit row (run/node
//       recovery) and, for a work item, the queue reap path that the board
//       surfaces — so nothing is silently lost.
//
// Wired into a server-plugin (recovery.ts) so it runs once on boot, and exposed
// headlessly via the `reconcile-on-startup` action + this function so the P6
// crash-recovery test can drive it deterministically.

import { eq, inArray } from "drizzle-orm";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { getDb, schema } from "../db/index.js";
import { nowIso } from "../../actions/_util.js";
import { resumeRun, type ControlOptions } from "../engine/control.js";
import { reapQueueOnce, type ReapedWorkItem } from "../queue/reap.js";
import { writeAudit } from "../audit/write-audit.js";

/** A NodeRun that was stranded `running` and reset for re-run (for the trail). */
export interface RecoveredNodeRun {
  id: string;
  runId: string;
  nodeId: string;
  attempts: number;
}

/** A workflow_run that was found `running` on startup and re-driven. */
export interface RecoveredRun {
  runId: string;
  /** NodeRuns reset from a stranded `running` to `pending` for re-run. */
  resetNodeRuns: RecoveredNodeRun[];
  /** Done NodeRuns that were preserved (NOT re-run) — the journal replay set. */
  preservedDoneCount: number;
  /** The run status after the re-drive (done | failed | paused | …). */
  status: string;
}

export interface ReconcileResult {
  /** Runs found `running` and re-driven (a). */
  recoveredRuns: RecoveredRun[];
  /** Work items the queue reap returned to `queued` (b). */
  requeuedWorkItems: ReapedWorkItem[];
}

/**
 * On startup the in-memory scheduler is gone, so EVERY NodeRun still marked
 * `running` is by definition stranded (no live driver is advancing it). We reset
 * those to `pending` so resume re-runs them; a heartbeat threshold is not needed
 * for the cold-start case (there is no live owner to out-race). A future hot
 * multi-isolate deploy would pass a threshold; the default here is "all running
 * is stranded" because a single-isolate restart owns the whole run store.
 */
async function resetStrandedRunningNodeRuns(
  runId: string,
): Promise<RecoveredNodeRun[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.nodeRuns)
    .where(eq(schema.nodeRuns.runId, runId));

  const reset: RecoveredNodeRun[] = [];
  const now = nowIso();
  for (const nr of rows) {
    if (nr.status !== "running") continue;
    // Reset to pending so scheduler.resume()'s Pass-1 dirty set includes it and
    // its transitive downstream — the §1.7 "stranded running re-runs whole".
    // A done NodeRun is left untouched (it replays from journal, NOT re-run).
    await db
      .update(schema.nodeRuns)
      .set({
        status: "pending",
        error: null,
        outputRef: null,
        completedAt: null,
        lastHeartbeat: null,
      })
      .where(eq(schema.nodeRuns.id, nr.id));
    reset.push({
      id: nr.id,
      runId,
      nodeId: nr.nodeId,
      attempts: nr.attempts,
    });
  }
  return reset;
}

/**
 * Reconcile one `running` workflow_run: reset its stranded `running` NodeRuns,
 * leave an audit trail, then re-drive via resume (done NodeRuns replay from the
 * journal at zero executor invocations). `opts` lets the test inject the echo
 * executor so recovery is VM-free + deterministic.
 */
async function recoverRun(
  runRow: typeof schema.workflowRuns.$inferSelect,
  opts: ControlOptions,
): Promise<RecoveredRun> {
  const db = getDb();
  const before = await db
    .select({ status: schema.nodeRuns.status })
    .from(schema.nodeRuns)
    .where(eq(schema.nodeRuns.runId, runRow.id));
  const preservedDoneCount = before.filter((r) => r.status === "done").length;

  const resetNodeRuns = await resetStrandedRunningNodeRuns(runRow.id);

  // TRAIL (c): one audit row per reset NodeRun + one for the run-level recovery.
  for (const nr of resetNodeRuns) {
    await writeAudit({
      action: "reconcile.startup",
      targetType: "node_run",
      targetId: nr.id,
      actor: "system",
      ownerEmail: runRow.ownerEmail,
      orgId: runRow.orgId ?? null,
      detail: {
        runId: runRow.id,
        nodeId: nr.nodeId,
        reset: "running→pending (stranded, re-run on resume)",
      },
    });
  }
  await writeAudit({
    action: "reconcile.startup",
    targetType: "workflow_run",
    targetId: runRow.id,
    actor: "system",
    ownerEmail: runRow.ownerEmail,
    orgId: runRow.orgId ?? null,
    detail: {
      resetNodeRuns: resetNodeRuns.length,
      preservedDoneCount,
    },
  });

  // RE-DRIVE: resume replays the journaled done NodeRuns (0 invokes) and re-runs
  // the reset (pending) ones + their tail. resumeRun re-establishes the run's
  // request context internally.
  const outcome = await resumeRun(runRow.id, opts);

  return {
    runId: runRow.id,
    resetNodeRuns,
    preservedDoneCount,
    status: outcome.status,
  };
}

/**
 * The full startup reconciliation (DESIGN §14). Runs inside the deployment-local
 * request context so ownable scoping resolves. Idempotent: a second call with no
 * stranded rows is a no-op. `opts.executor` (the echo executor) is forwarded to
 * the run re-drive so recovery is VM-free in tests.
 *
 * Order matters: requeue stranded work items FIRST (b) so a crashed worker's
 * item is back in the queue before anything else, THEN re-drive stranded runs
 * (a). The two are independent recovery surfaces — a run can be stranded without
 * its item, and vice-versa.
 */
export async function reconcileOnStartup(opts?: {
  ownerEmail?: string;
  orgId?: string | null;
  control?: ControlOptions;
}): Promise<ReconcileResult> {
  const ownerEmail = opts?.ownerEmail ?? "local@localhost";
  const orgId = opts?.orgId ?? null;
  const control = opts?.control ?? {};

  return runWithRequestContext(
    { userEmail: ownerEmail, orgId: orgId ?? undefined },
    async (): Promise<ReconcileResult> => {
      // (b) Re-queue stranded claimed/running work items via the queue reap. The
      // reap clears claimed_by/claimed_at + workflow_run_id so the next atomic
      // claim is clean — EXACTLY ONE worker re-claims (single-flight holds). On
      // startup we reap with a zero threshold so EVERY stranded item is returned
      // (no live worker can be beating after a cold restart).
      const requeuedWorkItems = await reapQueueOnce(0);
      for (const wi of requeuedWorkItems) {
        await writeAudit({
          action: "reconcile.startup",
          targetType: "work_item",
          targetId: wi.id,
          actor: "system",
          ownerEmail,
          orgId,
          detail: {
            requeued: `${wi.fromState}→queued`,
            claimedBy: wi.claimedBy,
          },
        });
      }

      // (a) Re-drive every workflow_run left `running`.
      const db = getDb();
      const runningRuns = await db
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.status, "running"));

      const recoveredRuns: RecoveredRun[] = [];
      for (const runRow of runningRuns) {
        recoveredRuns.push(await recoverRun(runRow, control));
      }

      return { recoveredRuns, requeuedWorkItems };
    },
  );
}

/**
 * Convenience: the set of run ids that are currently `running` (the recovery
 * candidates). Exposed so a caller/test can assert the candidate set before/after.
 */
export async function listRunningRunIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.workflowRuns.id })
    .from(schema.workflowRuns)
    .where(inArray(schema.workflowRuns.status, ["running"]));
  return rows.map((r) => r.id);
}
