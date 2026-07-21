// F8: 回链完整性 — append-only dispatch/run history per work item.
//
// Backed by `tracker_work_item_runs` (see schema.ts for the full rationale;
// SDLC-053). Two operations:
//
//   `recordDispatchRun` — called from EVERY successful-dispatch code path
//   (dispatch-to-orchestrator.ts's single-item path, bulk-dispatch-to-
//   orchestrator.ts's per-item path) right after the orchestrator hands back
//   a threadId. Marks any prior non-superseded row(s) for this work item
//   superseded=1, then inserts a fresh row (runId/branch start null — only
//   threadId is known at dispatch time).
//
//   `backfillWorkItemRun` — the idempotent upsert F9's writeback channel will
//   call once a run starts and its branch is known (runId/branch backfill).
//   Not wired to any action yet (F9 owns `actions/writeback-run-meta.ts`) —
//   exported here so the primitive exists, is directly unit-testable
//   (T-F8-04), and F9 only has to add a thin action on top. Also keeps
//   `work_items.orchestratorRunId` (the pre-F8 column, kept for read
//   compat — T-F8-07) in sync with the latest run row.
import { and, desc, eq, isNull } from "drizzle-orm";

import { getDb, schema } from "../db/index.js";

type Db = ReturnType<typeof getDb>;

export interface RecordDispatchRunInput {
  workItemId: string;
  threadId: string;
  ownerEmail: string;
  orgId: string | null;
  dispatchedAt: string;
}

/** Mark all of this item's currently-live run rows superseded, then insert a
 *  fresh row for the new dispatch. Never UPDATEs an existing row's
 *  thread/branch in place (that single-slot-overwrite behavior was
 *  SDLC-053) — a redispatch is always a NEW row, so `get-work-item.runs`
 *  keeps the full history (T-F8-03). */
export async function recordDispatchRun(
  db: Db,
  input: RecordDispatchRunInput,
): Promise<void> {
  await db
    .update(schema.workItemRuns)
    .set({ superseded: 1 })
    .where(
      and(
        eq(schema.workItemRuns.workItemId, input.workItemId),
        eq(schema.workItemRuns.superseded, 0),
      ),
    );

  const id = `wir_${input.workItemId.slice(0, 6)}_${input.dispatchedAt.replace(/\D/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
  await db.insert(schema.workItemRuns).values({
    id,
    workItemId: input.workItemId,
    runId: null,
    threadId: input.threadId,
    branch: null,
    dispatchedAt: input.dispatchedAt,
    superseded: 0,
    createdAt: input.dispatchedAt,
    ownerEmail: input.ownerEmail,
    orgId: input.orgId,
    visibility: "private",
  });
}

export interface BackfillWorkItemRunInput {
  workItemId: string;
  runId: string;
  branch?: string | null;
  ownerEmail: string;
  orgId: string | null;
}

/**
 * Idempotent run backfill: attach a runId (and optionally branch) to this
 * item's current (non-superseded, runId IS NULL) dispatch row, and mirror it
 * onto `work_items.orchestratorRunId` for old-column read compat (T-F8-07).
 *
 * UNIQUE(work_item_id, run_id) means calling this twice with the SAME runId
 * is a no-op the second time — T-F8-04. Implemented as an explicit
 * find-then-conditionally-write rather than a blind upsert because the
 * target row to attach to is "the current live dispatch row" (superseded=0,
 * runId still null), not identified by runId (which doesn't exist on that
 * row yet).
 */
export async function backfillWorkItemRun(
  db: Db,
  input: BackfillWorkItemRunInput,
): Promise<{ updated: boolean }> {
  // Already recorded under this exact runId? No-op (idempotent re-report).
  const already = (
    await db
      .select({ id: schema.workItemRuns.id })
      .from(schema.workItemRuns)
      .where(
        and(
          eq(schema.workItemRuns.workItemId, input.workItemId),
          eq(schema.workItemRuns.runId, input.runId),
        ),
      )
      .limit(1)
  )[0];
  if (already) return { updated: false };

  // The current live (not-yet-backfilled) dispatch row: superseded=0, runId
  // still null. Attach runId/branch to it.
  const target = (
    await db
      .select({ id: schema.workItemRuns.id })
      .from(schema.workItemRuns)
      .where(
        and(
          eq(schema.workItemRuns.workItemId, input.workItemId),
          eq(schema.workItemRuns.superseded, 0),
          isNull(schema.workItemRuns.runId),
        ),
      )
      .orderBy(desc(schema.workItemRuns.dispatchedAt))
      .limit(1)
  )[0];
  if (!target) return { updated: false };

  await db
    .update(schema.workItemRuns)
    .set({
      runId: input.runId,
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    })
    .where(eq(schema.workItemRuns.id, target.id));

  // Mirror onto the old column — kept in sync, downgraded to "latest one"
  // semantics (see schema.ts / T-F8-07).
  await db
    .update(schema.workItems)
    .set({
      orchestratorRunId: input.runId,
      ...(input.branch ? { branch: input.branch } : {}),
    })
    .where(eq(schema.workItems.id, input.workItemId));

  return { updated: true };
}

export interface WorkItemRunSummary {
  runId: string | null;
  threadId: string | null;
  branch: string | null;
  dispatchedAt: string;
  superseded: boolean;
}

/** Read a work item's run history, newest first — the shape `get-work-item`
 *  exposes as `runs[]` (S4 execution-group list). */
export async function listWorkItemRuns(
  db: Db,
  workItemId: string,
): Promise<WorkItemRunSummary[]> {
  const rows = await db
    .select({
      runId: schema.workItemRuns.runId,
      threadId: schema.workItemRuns.threadId,
      branch: schema.workItemRuns.branch,
      dispatchedAt: schema.workItemRuns.dispatchedAt,
      superseded: schema.workItemRuns.superseded,
    })
    .from(schema.workItemRuns)
    .where(eq(schema.workItemRuns.workItemId, workItemId))
    .orderBy(desc(schema.workItemRuns.dispatchedAt));
  return rows.map((r) => ({
    runId: r.runId ?? null,
    threadId: r.threadId ?? null,
    branch: r.branch ?? null,
    dispatchedAt: r.dispatchedAt,
    superseded: !!r.superseded,
  }));
}
