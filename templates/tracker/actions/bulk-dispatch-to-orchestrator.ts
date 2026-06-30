import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { callOrchestratorTool } from "../server/lib/orchestrator-client.js";

// Bulk-dispatch many work items to the orchestrator brain in one atomic action.
// Loops the proven single-item dispatch logic (mint JWT → MCP `brain-send` with
// tags={source:"tracker", item_id} + the project's repo/branch), but now also
// captures the orchestrator's ADMISSION-GATE result: brain-send returns
// `{ threadId, status: "running"|"queued", queuePosition, taskId }`. We persist
// the returned status (queued/running, mapped onto the widened work-item
// vocabulary) plus the brain_task id so the board reflects the live slot gate.
//
// One network call per item, run with bounded concurrency and all writes inside
// this single server action (per the reliable-mutations tenet — never N client
// round-trips). Partial failures are collected per item and reported, not
// thrown, so one bad item never aborts the rest of the batch.

const MAX_BATCH = 100;

// brain-send admission result. NEW dispatch path returns taskId; both paths
// return status + queuePosition.
interface BrainSendResult {
  threadId?: string;
  status?: "running" | "queued";
  queuePosition?: number;
  taskId?: string;
  workspaceId?: string | null;
  running?: number;
}

// Map the orchestrator slot state onto the work-item lifecycle. `running` means
// a slot is held and the brain is executing; `queued` means it's waiting for a
// slot. Anything unexpected falls back to the legacy `dispatched`.
function statusForSlot(slot: string | undefined): string {
  if (slot === "running") return "running";
  if (slot === "queued") return "queued";
  return "dispatched";
}

export default defineAction({
  description:
    "Dispatch MANY work items to the orchestrator brain at once. Loops the " +
    "single-item dispatch (carries each item's requirement + its project's " +
    "repo/branch + tracker tags), then records the orchestrator's admission " +
    "result per item — status (queued|running), the brain thread id, and the " +
    "brain_task id — so the board reflects the live concurrency slot gate. " +
    "Returns a per-item result array; partial failures are reported, not thrown.",
  schema: z.object({
    workItemIds: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BATCH)
      .describe("Work items to dispatch (deduped; max 100 per batch)."),
    monitorIntervalSec: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Periodic drift-check cadence (seconds) for each brain monitor. Omit → " +
          "server default; 0 → event-only (no timer wakes).",
      ),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const ids = Array.from(new Set(args.workItemIds));

    // Load all requested items the caller can access, in one scoped read.
    const items = await db
      .select()
      .from(schema.workItems)
      .where(
        and(inArray(schema.workItems.id, ids), ownerScope(schema.workItems)),
      );
    const itemById = new Map(items.map((it) => [it.id, it]));

    // Preload the owning projects (one read) for repo/branch resolution.
    const projectIds = Array.from(new Set(items.map((it) => it.projectId)));
    const projects = projectIds.length
      ? await db
          .select()
          .from(schema.projects)
          .where(inArray(schema.projects.id, projectIds))
      : [];
    const projectById = new Map(projects.map((p) => [p.id, p]));

    type ItemResult = {
      workItemId: string;
      ok: boolean;
      status?: string;
      threadId?: string;
      taskId?: string | null;
      queuePosition?: number | null;
      error?: string;
    };

    // Dispatch one item: load context, call brain-send, write back. Returns a
    // result record; never throws (failures are captured per item).
    async function dispatchOne(id: string): Promise<ItemResult> {
      const item = itemById.get(id);
      if (!item) {
        return { workItemId: id, ok: false, error: "Not found or not accessible" };
      }
      const project = projectById.get(item.projectId);
      if (!project) {
        return { workItemId: id, ok: false, error: "Owning project not found" };
      }
      if (!project.gitRemote) {
        return {
          workItemId: id,
          ok: false,
          error: "Project has no git remote configured",
        };
      }

      const tags = { source: "tracker", item_id: item.id };
      const requirement = item.description?.trim() || item.title;
      const message =
        `Work item ${item.id} (${project.key}) — "${item.title}".\n\n` +
        `Requirement:\n${requirement}\n\n` +
        `Work in the checked-out workspace. Follow the orchestrating-v3 skill: ` +
        `decompose as needed (CC analyze, vLLM develop, CC review), monitor by ` +
        `polling, then workspaceCommitPush to open a PR. When done, report the ` +
        `run id and the PR url.`;

      try {
        const { data } = await callOrchestratorTool(ownerEmail!, "brain-send", {
          message,
          repo: project.gitRemote,
          baseBranch: project.defaultBranch || "main",
          tags,
          ...(args.monitorIntervalSec !== undefined
            ? { monitorIntervalSec: args.monitorIntervalSec }
            : {}),
        });

        const result = data as BrainSendResult;
        const threadId = result?.threadId;
        if (!threadId) {
          return {
            workItemId: id,
            ok: false,
            error: `No threadId returned: ${JSON.stringify(data).slice(0, 200)}`,
          };
        }

        const status = statusForSlot(result.status);
        const now = new Date().toISOString();
        await db
          .update(schema.workItems)
          .set({
            status,
            orchestratorThreadId: threadId,
            orchestratorTaskId: result.taskId ?? null,
            orchestratorWorkspaceId: result.workspaceId ?? null,
            dispatchedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.workItems.id, item.id));

        return {
          workItemId: id,
          ok: true,
          status,
          threadId,
          taskId: result.taskId ?? null,
          queuePosition: result.queuePosition ?? null,
        };
      } catch (err) {
        return {
          workItemId: id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Bounded concurrency: dispatch in small waves so the admission gate sees
    // the calls roughly in order (the gate is server-serialized anyway) without
    // opening N simultaneous sockets.
    const WAVE = 4;
    const results: ItemResult[] = [];
    for (let i = 0; i < ids.length; i += WAVE) {
      const wave = ids.slice(i, i + WAVE);
      const settled = await Promise.all(wave.map((id) => dispatchOne(id)));
      results.push(...settled);
    }

    const dispatched = results.filter((r) => r.ok).length;
    const failed = results.length - dispatched;
    return {
      requested: ids.length,
      dispatched,
      failed,
      results,
    };
  },
});
