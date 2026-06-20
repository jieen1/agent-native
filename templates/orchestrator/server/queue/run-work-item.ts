// Start a workflow run FOR a work item (DESIGN §6.4 / §4.3 / §0.6). This is the
// `run-start({ workItemId })` path that P1 stubbed as "not implemented until P3".
//
// For P3b the workflow is resolved by the EXPLICIT item.workflowId (a
// workflow_template id) only — the project-default + dynamic-build decomposition
// (§6.3) is P3c. If the item has no workflowId (and no reachable template) the
// run is created and finalized `failed` with a clear "no workflow" reason rather
// than crashing the worker, so the queue keeps draining.
//
// The created workflow_run binds `work_item_id`, so the watchdog (§6.2b L2) and
// the run console can reconcile against the item. Business `status` is NEVER
// written here — the queue is automation-only (§6.4); the agent moves status via
// transition-work-item.

import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { newId, nowIso } from "../../actions/_util.js";
import { executeRun, type ExecuteRunOptions } from "../engine/index.js";
import type { RunOutcome } from "../engine/scheduler.js";

export interface StartRunForWorkItemResult {
  runId: string;
  /**
   * Final run status, "failed" when no workflow could be resolved, or "pending"
   * when created with execute:false (the caller drives it).
   */
  status: RunOutcome["status"] | "failed" | "pending";
  tokensSpent: number;
  /** Set when the run failed because the item had no resolvable workflow. */
  noWorkflow?: boolean;
  reason?: string;
}

/**
 * Resolve the work item's workflow, create a workflow_run bound to the item, and
 * (when `execute` is true, the default) drive it to completion. The caller
 * (run-start action, worker pool) owns moving the item's execState; this helper
 * owns the run row + execution.
 *
 * Must run inside a request context (resolveAccess / ownable scoping / secrets).
 */
export async function startRunForWorkItem(
  workItemId: string,
  opts: {
    ownerEmail: string;
    orgId: string | null;
    tokenBudget?: number | null;
    execute?: boolean;
    executeOpts?: ExecuteRunOptions;
  },
): Promise<StartRunForWorkItemResult> {
  const db = getDb();
  const itemRows = await db
    .select()
    .from(schema.workItems)
    .where(eq(schema.workItems.id, workItemId))
    .limit(1);
  const item = itemRows[0];
  if (!item) throw new Error(`Work item ${workItemId} not found`);

  const now = nowIso();
  const templateId = item.workflowId ?? null;

  // No explicit workflow → resolve fails for P3b (project-default + dynamic
  // build is P3c). Create a failed run with a clear reason, bind it to the item.
  if (!templateId) {
    const runId = newId("run");
    await db.insert(schema.workflowRuns).values({
      id: runId,
      templateId: "",
      workItemId,
      status: "failed",
      deliverable: null,
      tokenBudget: opts.tokenBudget ?? null,
      tokensSpent: 0,
      startedAt: now,
      completedAt: now,
      ownerEmail: opts.ownerEmail,
      orgId: opts.orgId,
      visibility: "private",
    });
    await db
      .update(schema.workItems)
      .set({ workflowRunId: runId, updatedAt: now })
      .where(eq(schema.workItems.id, workItemId));
    return {
      runId,
      status: "failed",
      tokensSpent: 0,
      noWorkflow: true,
      reason:
        "no workflow: item has no workflowId (project-default + dynamic build is P3c)",
    };
  }

  // Verify the template exists (and is not soft-deleted) before scheduling.
  const tplRows = await db
    .select({ id: schema.workflowTemplates.id })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, templateId))
    .limit(1);
  if (!tplRows[0]) {
    const runId = newId("run");
    await db.insert(schema.workflowRuns).values({
      id: runId,
      templateId,
      workItemId,
      status: "failed",
      deliverable: null,
      tokenBudget: opts.tokenBudget ?? null,
      tokensSpent: 0,
      startedAt: now,
      completedAt: now,
      ownerEmail: opts.ownerEmail,
      orgId: opts.orgId,
      visibility: "private",
    });
    await db
      .update(schema.workItems)
      .set({ workflowRunId: runId, updatedAt: now })
      .where(eq(schema.workItems.id, workItemId));
    return {
      runId,
      status: "failed",
      tokensSpent: 0,
      noWorkflow: true,
      reason: `no workflow: template ${templateId} not found`,
    };
  }

  const runId = newId("run");
  await db.insert(schema.workflowRuns).values({
    id: runId,
    templateId,
    workItemId,
    status: "pending",
    deliverable: null,
    tokenBudget: opts.tokenBudget ?? null,
    tokensSpent: 0,
    startedAt: now,
    completedAt: null,
    ownerEmail: opts.ownerEmail,
    orgId: opts.orgId,
    visibility: "private",
  });
  await db
    .update(schema.workItems)
    .set({ workflowRunId: runId, updatedAt: now })
    .where(eq(schema.workItems.id, workItemId));

  if (opts.execute === false) {
    return { runId, status: "pending", tokensSpent: 0 };
  }

  const outcome = await executeRun(runId, opts.executeOpts ?? {});
  return {
    runId,
    status: outcome.status,
    tokensSpent: outcome.tokensSpent,
  };
}
