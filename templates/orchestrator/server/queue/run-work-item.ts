// Start a workflow run FOR a work item (DESIGN §6.4 / §6.3 / §4.3 / §0.6). This
// is the `run-start({ workItemId })` path and the queue worker's per-item entry.
//
// DECOMPOSITION — THREE ORDER (DESIGN §6.3), resolved here:
//   1. explicit item.workflowId         → use that template     (source: "explicit")
//   2. else project.defaultWorkflowId    → use that template     (source: "default")
//   3. else DYNAMIC                       → the brain authors the DAG. For P3c this
//      path does NOT hardcode an LLM call: it creates the run marked
//      `dynamic_authored = 1`, leaves it `pending`, and surfaces a clear hook so
//      the orchestrating agent/skill builds + promotes the graph.  (source: "dynamic")
//
// A resolved delivery graph always passes through the finalize-status gate
// (DESIGN §6.2b L1): the gate is auto-injected at save-template time, and the
// engine's NodeGate asserts the agent set a near-terminal status at run time.
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

/** Where the run's template came from (DESIGN §6.3 three-order). */
export type TemplateSource = "explicit" | "default" | "dynamic";

export interface StartRunForWorkItemResult {
  runId: string;
  /**
   * Final run status, "failed" when no workflow could be resolved, "pending"
   * when created with execute:false (the caller drives it) OR when the run is a
   * dynamic-authored placeholder awaiting the brain.
   */
  status: RunOutcome["status"] | "failed" | "pending";
  tokensSpent: number;
  /** The resolved template id ("" for the no-workflow / dynamic placeholder). */
  templateId: string;
  /** Which of the three decomposition orders resolved this run (§6.3). */
  templateSource: TemplateSource;
  /** True when the run was created via the dynamic-authored path (order 3). */
  dynamicAuthored: boolean;
  /** Set when the run failed because the item had no resolvable workflow. */
  noWorkflow?: boolean;
  reason?: string;
}

/** A template the decomposition resolved (id + whether it is still loadable). */
interface ResolvedTemplate {
  templateId: string;
  source: "explicit" | "default";
}

/**
 * Resolve the work item's workflow template by the three-order rule. Returns the
 * resolved template (explicit or default) with its source, or null when neither
 * is set (→ the dynamic path). Does NOT check the template exists — the caller
 * does, so it can produce a precise "template not found" run.
 */
function resolveWorkflowTemplate(
  item: { workflowId: string | null },
  project: { defaultWorkflowId: string | null } | null,
): ResolvedTemplate | null {
  if (item.workflowId) {
    return { templateId: item.workflowId, source: "explicit" };
  }
  if (project?.defaultWorkflowId) {
    return { templateId: project.defaultWorkflowId, source: "default" };
  }
  return null;
}

/**
 * Resolve the work item's workflow (three-order, §6.3), create a workflow_run
 * bound to the item, and (when `execute` is true, the default) drive it to
 * completion. The caller (run-start action, worker pool) owns moving the item's
 * execState; this helper owns the run row + execution.
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

  // Load the project so order 2 (defaultWorkflowId) can resolve.
  const projRows = await db
    .select({ defaultWorkflowId: schema.projects.defaultWorkflowId })
    .from(schema.projects)
    .where(eq(schema.projects.id, item.projectId))
    .limit(1);
  const project = projRows[0] ?? null;

  const resolved = resolveWorkflowTemplate(item, project);

  // ── ORDER 3: DYNAMIC — neither explicit nor default. The brain authors the
  // DAG. P3c does NOT call an LLM here: create a placeholder run marked
  // dynamic_authored, leave it pending, and surface the hook. ────────────────
  if (!resolved) {
    const runId = newId("run");
    await db.insert(schema.workflowRuns).values({
      id: runId,
      templateId: "",
      workItemId,
      status: "pending",
      deliverable: null,
      tokenBudget: opts.tokenBudget ?? null,
      tokensSpent: 0,
      dynamicAuthored: 1,
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
    return {
      runId,
      status: "pending",
      tokensSpent: 0,
      templateId: "",
      templateSource: "dynamic",
      dynamicAuthored: true,
      reason:
        "dynamic-authored: no explicit workflowId and no project defaultWorkflowId — " +
        "the orchestrating agent must build a DAG (wiring vetted library gates incl. " +
        "finalize-status) via save-template, then run it. See the `orchestrating` skill.",
    };
  }

  const templateId = resolved.templateId;

  // Verify the resolved template exists (and is not soft-deleted) before
  // scheduling. A missing template → a clear failed run (queue keeps draining).
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
      dynamicAuthored: 0,
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
      templateId,
      templateSource: resolved.source,
      dynamicAuthored: false,
      noWorkflow: true,
      reason: `no workflow: ${resolved.source} template ${templateId} not found`,
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
    dynamicAuthored: 0,
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
    return {
      runId,
      status: "pending",
      tokensSpent: 0,
      templateId,
      templateSource: resolved.source,
      dynamicAuthored: false,
    };
  }

  const outcome = await executeRun(runId, opts.executeOpts ?? {});
  return {
    runId,
    status: outcome.status,
    tokensSpent: outcome.tokensSpent,
    templateId,
    templateSource: resolved.source,
    dynamicAuthored: false,
  };
}
