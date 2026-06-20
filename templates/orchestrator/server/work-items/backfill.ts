// v1 → v2 backfill (DESIGN §9 — one-way, NON-destructive, IDEMPOTENT). Copies
// each v1 `tasks` row into a v2 `work_items` row (type=task), preserving an id
// mapping so re-running adds no duplicate rows. The v1 `tasks`/`workflows`/
// `step_runs` rows are NEVER touched (read-only copy). The workflow→template and
// step_run→node_run mapping is NOTED but stubbed for P3a (work_item backfill only).
//
// Idempotency mechanism: each task maps to a DETERMINISTIC work_item id
// `wi_t_<taskId>` (a pure function of the task id), so a second run finds the row
// already present and skips it — no UUID drift, no duplicates.

import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { nowIso } from "../../actions/_util.js";
import { initialStage } from "../../shared/status-schemes.js";
import { schemeForType } from "./schemes.js";

/** The deterministic work_item id a v1 task backfills into (id mapping). */
export function backfillWorkItemId(taskId: string): string {
  return `wi_t_${taskId}`;
}

/** The deterministic backfill-project id for an owner (one per owner). */
export function backfillProjectId(ownerEmail: string): string {
  // A stable, owner-scoped id so re-runs reuse the same holding project.
  return `proj_backfill_${encodeURIComponent(ownerEmail)}`;
}

/**
 * Map a v1 task status onto a v2 `task`-scheme stage + category. v1 statuses are
 * pending|running|done|failed|cancelled; the v2 task scheme has 待办(todo) /
 * 进行中(in-progress) / 已完成(completed) / 已取消(cancelled). `failed` has no
 * direct stage — it stays at the in-progress stage (the run failed, the work
 * item is not "done"); execState carries the failure separately (§6.2a).
 */
function mapV1Status(
  v1Status: string,
  scheme: ReturnType<typeof schemeForType>,
): { status: string; category: string; resolution: string | null } {
  const todo = scheme.stages.find((s) => s.category === "todo")?.key ?? "待办";
  const inProgress =
    scheme.stages.find((s) => s.category === "in-progress")?.key ?? "进行中";
  const completed =
    scheme.stages.find((s) => s.category === "completed")?.key ?? "已完成";
  const cancelled =
    scheme.stages.find((s) => s.category === "cancelled")?.key ?? "已取消";
  switch (v1Status) {
    case "done":
      return {
        status: completed,
        category: "completed",
        resolution: "shipped",
      };
    case "cancelled":
      return {
        status: cancelled,
        category: "cancelled",
        resolution: "cancelled",
      };
    case "running":
    case "failed":
      return { status: inProgress, category: "in-progress", resolution: null };
    case "pending":
    default:
      return { status: todo, category: "todo", resolution: null };
  }
}

export interface BackfillResult {
  /** The owner-scoped holding project id work items were backfilled into. */
  projectId: string;
  /** Number of v1 tasks examined for this owner. */
  tasksSeen: number;
  /** Number of NEW work_items created this run (0 on an idempotent re-run). */
  created: number;
  /** Number of tasks skipped because their work_item already existed. */
  skipped: number;
}

/**
 * Backfill all of one owner's v1 tasks into v2 work items. Idempotent: a second
 * call creates 0 rows. Does NOT modify v1 tables.
 *
 * @param ownerEmail the owner whose tasks to backfill (data-scoped).
 * @param orgId the owner's org id (carried onto the new rows / holding project).
 */
export async function backfillTasksForOwner(
  ownerEmail: string,
  orgId: string | null,
): Promise<BackfillResult> {
  const db = getDb();
  const now = nowIso();

  // Ensure the owner's holding project exists (deterministic id → idempotent).
  const projectId = backfillProjectId(ownerEmail);
  const existingProj = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  if (existingProj.length === 0) {
    await db.insert(schema.projects).values({
      id: projectId,
      name: "Backfilled v1 Tasks",
      key: "V1",
      description:
        "Holding project for v1 tasks migrated to v2 work items (one-way, non-destructive).",
      workingDir: "v1-backfill",
      gitRemote: null,
      defaultBranch: null,
      defaultWorkflowId: null,
      statusSchemes: null,
      environments: null,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });
  }

  const scheme = schemeForType(null, "task");
  const fallbackStage = initialStage(scheme);

  // Read v1 tasks for this owner that are not soft-deleted (read-only).
  const tasks = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.ownerEmail, ownerEmail),
        isNull(schema.tasks.deletedAt),
      ),
    );

  let created = 0;
  let skipped = 0;
  for (const t of tasks) {
    const wiId = backfillWorkItemId(t.id);
    const exists = await db
      .select({ id: schema.workItems.id })
      .from(schema.workItems)
      .where(eq(schema.workItems.id, wiId))
      .limit(1);
    if (exists.length > 0) {
      skipped += 1;
      continue;
    }
    const mapped = mapV1Status(t.status, scheme);
    await db.insert(schema.workItems).values({
      id: wiId,
      projectId,
      type: "task",
      title: t.title,
      description: t.description ?? "",
      priority: 0,
      assignee: null,
      status: mapped.status || fallbackStage,
      statusCategory: mapped.category as
        | "todo"
        | "in-progress"
        | "completed"
        | "cancelled",
      environment: null,
      severity: null,
      blocked: 0,
      blockedReason: null,
      blockedBy: null,
      resolution: mapped.resolution,
      statusStale: 0,
      execState: "idle",
      claimedAt: null,
      claimedBy: null,
      workflowId: t.workflowId ?? null,
      workflowRunId: null,
      deliverable: t.result
        ? JSON.stringify({ kind: "text", ref: t.result })
        : null,
      createdAt: t.createdAt,
      updatedAt: now,
      ownerEmail,
      orgId: t.orgId ?? null,
      visibility: "private",
    });
    // Record the backfilled landing stage in the trail (actor = backfill).
    await db.insert(schema.workItemStatusLog).values({
      id: `wisl_bf_${t.id}`,
      workItemId: wiId,
      runId: null,
      actor: "backfill",
      fromStatus: null,
      toStatus: mapped.status || fallbackStage,
      blocked: 0,
      resolution: mapped.resolution,
      at: now,
    });
    created += 1;
  }

  return { projectId, tasksSeen: tasks.length, created, skipped };
}
