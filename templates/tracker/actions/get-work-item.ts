import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { computeItemKeyDisplay } from "../server/lib/item-key-display.js";
import {
  actorFromCaller,
  allowedTransitions,
  type Actor,
} from "../server/lib/transition-guard.js";
import {
  listWorkItemRuns,
  type WorkItemRunSummary,
} from "../server/lib/work-item-runs.js";

type WorkItemRow = typeof schema.workItems.$inferSelect;
type ProjectRow = {
  id: string;
  key: string;
  name: string;
  gitRemote: string;
  defaultBranch: string;
} | null;
type SprintRow = { id: string; name: string; status: string | null } | null;

/**
 * Read-compat fallback for items dispatched BEFORE `tracker_work_item_runs`
 * (F8, SDLC-053) started recording history: `listWorkItemRuns` legitimately
 * returns `[]` for these (no row was ever inserted — `recordDispatchRun` only
 * fires on dispatch, and pre-existing dispatches were never backfilled into
 * the new table). Without this fallback `RunEvidenceList` silently renders
 * nothing for every item dispatched before the feature shipped, even when the
 * orchestrator has a real, completed run for it — confirmed in production for
 * SDLC-040/041/043, all dispatched 2026-07-11 with real `v3_runs` rows, whose
 * `get-work-item.runs` came back `[]`.
 *
 * Synthesizes a single "current" run summary from the columns that already
 * existed before F8 (`orchestratorThreadId`/`orchestratorRunId`/`branch`/
 * `dispatchedAt` — the same ones `backfillWorkItemRun` mirrors onto for
 * post-F8 items, "T-F8-07" in work-item-runs.ts). Only degrades: once this
 * item is ever redispatched, `recordDispatchRun` inserts a real row and this
 * fallback stops being reached (`listWorkItemRuns` returns non-empty).
 */
export function legacyRunFallback(
  item: Pick<
    WorkItemRow,
    | "orchestratorThreadId"
    | "orchestratorRunId"
    | "branch"
    | "dispatchedAt"
    | "updatedAt"
  >,
): WorkItemRunSummary[] {
  if (!item.orchestratorThreadId) return [];
  return [
    {
      runId: item.orchestratorRunId ?? null,
      threadId: item.orchestratorThreadId,
      branch: item.branch ?? null,
      dispatchedAt: item.dispatchedAt ?? item.updatedAt,
      superseded: false,
    },
  ];
}

/** Pure shaping of a DB work-item row into the get-work-item detail payload.
 *  Exported (not just used inline) so tests can assert on the shape without touching the DB.
 *  `actor` is optional so existing callers/tests that don't care about
 *  guard-gated allowedTransitions keep working — omit it to get an empty
 *  `allowedTransitions: []` (safest default: nothing offered until identity
 *  is known). */
export function shapeWorkItemDetail(
  item: WorkItemRow,
  project: ProjectRow,
  sprint: SprintRow,
  actor?: Actor,
  extra?: { runs?: WorkItemRunSummary[]; itemKeyDisplay?: string },
) {
  const execState = (item as { execState?: string | null }).execState ?? null;
  const closedReason =
    (item as { closedReason?: string | null }).closedReason ?? null;
  const closedAt = (item as { closedAt?: string | null }).closedAt ?? null;
  // F5 (v25): scale_estimate is stored as a JSON string — parse it for the
  // client so the S4 badge/warning-bar don't each re-implement JSON.parse.
  const rawScaleEstimate =
    (item as { scaleEstimate?: string | null }).scaleEstimate ?? null;
  let scaleEstimate: unknown = null;
  if (rawScaleEstimate) {
    try {
      scaleEstimate = JSON.parse(rawScaleEstimate);
    } catch {
      scaleEstimate = null;
    }
  }
  const splitParentId =
    (item as { splitParentId?: string | null }).splitParentId ?? null;
  return {
    id: item.id,
    projectId: item.projectId,
    type: item.type,
    title: item.title,
    description: item.description,
    status: item.status,
    priority: item.priority,
    orchestratorThreadId: item.orchestratorThreadId,
    orchestratorTaskId: item.orchestratorTaskId,
    orchestratorRunId: item.orchestratorRunId,
    orchestratorWorkspaceId: item.orchestratorWorkspaceId,
    dispatchedAt: item.dispatchedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    sprintId: item.sprintId,
    itemKey: item.itemKey,
    // F8: reads-only disambiguation for historical duplicate itemKeys
    // (SDLC-032~036) — the raw itemKey, unless it collides with a sibling in
    // the same project, in which case a short id suffix is appended. Falls
    // back to the raw itemKey when the caller didn't compute it (existing
    // callers/tests that don't pass `extra` keep working unchanged).
    itemKeyDisplay: extra?.itemKeyDisplay ?? item.itemKey,
    // F8 (回链完整性): full dispatch/run history, newest first. Empty until
    // ever dispatched. A redispatch appends a new row rather than overwriting
    // the previous one (SDLC-053) — see server/lib/work-item-runs.ts.
    runs: extra?.runs ?? [],
    risk: item.risk,
    tags: (() => {
      try {
        return JSON.parse(item.tags ?? "[]");
      } catch {
        return [];
      }
    })(),
    executionMode: item.executionMode,
    currentStageName: item.currentStageName,
    plannedStages: (() => {
      try {
        return JSON.parse(item.plannedStages ?? "[]");
      } catch {
        return [];
      }
    })(),
    branch: item.branch,
    owner: item.owner ?? null,
    nature: (() => {
      try {
        return JSON.parse(item.nature ?? "[]");
      } catch {
        return [];
      }
    })(),
    sprint: sprint ?? null,
    project: project ?? null,
    // F3: execState is the dispatch-tracking column (null|queued|dispatched|
    // running|returned) — distinct from `status`, and never advances
    // currentStageName. closedReason/closedAt are populated once a human
    // closes the item via transition-work-item(target=closed).
    execState,
    closedReason,
    closedAt,
    // F5 (v25): 规模估算(estimate-brief-scale.ts 写入)+ 拆分父项指针
    // (split-work-item.ts 写在每个 child 上)。
    scaleEstimate,
    splitParentId,
    // F3 (T-F3-08): the SAME guard function transition-work-item calls,
    // computed server-side from the caller's resolved identity — front and
    // back read one source of truth, never a re-implemented client-side copy
    // of the guard table. Agents (MCP/tool callers) always get [].
    allowedTransitions: actor
      ? allowedTransitions(
          {
            currentStageName: item.currentStageName,
            status: item.status,
            execState,
          },
          actor,
        )
      : [],
  };
}

export default defineAction({
  description: "Get a single work item with its owning project context.",
  schema: z.object({
    id: z.string().min(1).describe("Work item id"),
  }),
  http: { method: "GET" },
  run: async (args, ctx) => {
    const db = getDb();
    const item = (
      await db
        .select()
        .from(schema.workItems)
        .where(
          and(eq(schema.workItems.id, args.id), ownerScope(schema.workItems)),
        )
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found or not accessible");

    const project = (
      await db
        .select({
          id: schema.projects.id,
          key: schema.projects.key,
          name: schema.projects.name,
          gitRemote: schema.projects.gitRemote,
          defaultBranch: schema.projects.defaultBranch,
        })
        .from(schema.projects)
        .where(eq(schema.projects.id, item.projectId))
        .limit(1)
    )[0];

    const sprint = item.sprintId
      ? ((
          await db
            .select({
              id: schema.sprints.id,
              name: schema.sprints.name,
              status: schema.sprints.status,
            })
            .from(schema.sprints)
            .where(eq(schema.sprints.id, item.sprintId))
            .limit(1)
        )[0] ?? null)
      : null;

    const actor = actorFromCaller(ctx?.caller, getRequestUserEmail());
    const [recordedRuns, itemKeyDisplay] = await Promise.all([
      listWorkItemRuns(db, item.id),
      computeItemKeyDisplay(db, {
        id: item.id,
        projectId: item.projectId,
        itemKey: item.itemKey,
      }),
    ]);
    // Read-compat: items dispatched before F8's tracker_work_item_runs table
    // existed have no recorded history row — fall back to the legacy columns
    // rather than silently showing no run evidence (see legacyRunFallback).
    const runs = recordedRuns.length ? recordedRuns : legacyRunFallback(item);
    return shapeWorkItemDetail(item, project ?? null, sprint, actor, {
      runs,
      itemKeyDisplay,
    });
  },
});
