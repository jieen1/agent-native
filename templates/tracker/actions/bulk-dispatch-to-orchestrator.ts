import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { callOrchestratorTool } from "../server/lib/orchestrator-client.js";
import { resolveDispatchGate } from "../server/lib/dispatch-gate.js";
import { resolveScaleGate } from "../server/lib/scale-gate.js";
import { actorFromCaller } from "../server/lib/transition-guard.js";
import { recordDispatchRun } from "../server/lib/work-item-runs.js";

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
    // F5 (02 §3.10 决策序①): human scale-override, batch-level + per-item.
    overrideScale: z
      .boolean()
      .optional()
      .describe(
        "Batch-level scale override: dispatch every over-scale item anyway " +
          "(logs scale.overridden per item). Prefer overrideScaleIds to override " +
          "only specific items.",
      ),
    overrideScaleIds: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Per-item scale override: only these ids bypass the split-required gate; " +
          "other over-scale items are skipped (reason=scale-exceeded).",
      ),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;
    // F5: real actor (agent vs human) for the scale.overridden activity row —
    // never hardcode human (mirrors dispatch-to-orchestrator / F3 T-F3-18b).
    const actor = actorFromCaller(ctx?.caller, ownerEmail);
    const overrideScaleIdSet = new Set(args.overrideScaleIds ?? []);

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
      execState?: string;
      currentStageName?: string;
      threadId?: string;
      taskId?: string | null;
      queuePosition?: number | null;
      blockedBy?: string[];
      error?: string;
      // F5: over-scale item skipped (not dispatched, not a hard failure).
      skipped?: boolean;
      reason?: string;
      estimate?: unknown;
      scaleOverridden?: boolean;
    };

    // Dispatch one item: load context, call brain-send, write back. Returns a
    // result record; never throws (failures are captured per item).
    async function dispatchOne(id: string): Promise<ItemResult> {
      // F9 review fix: `run()` already guards `ownerEmail` with an explicit
      // `if (!ownerEmail) throw` before dispatchOne is ever invoked, but
      // TypeScript doesn't carry that narrowing across the closure boundary
      // into this nested function — the prior code papered over that with a
      // bare `ownerEmail!` when building the writeback tags. Match this
      // function's own per-item error-return discipline (used for the other
      // preconditions below) instead of a silent non-null assertion: an
      // explicit, in-scope guard right here narrows `ownerEmail` to `string`
      // for the rest of this function, and — should the impossible ever
      // happen — fails this ONE item with a clear reason rather than
      // asserting past it.
      if (!ownerEmail) {
        return { workItemId: id, ok: false, error: "Not authenticated" };
      }
      const item = itemById.get(id);
      if (!item) {
        return {
          workItemId: id,
          ok: false,
          error: "Not found or not accessible",
        };
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

      // ── Dependency gate check ───────────────────────────────────────────────
      const orgId = getRequestOrgId() ?? null;
      const gate = await resolveDispatchGate(db, id, ownerEmail!, orgId);
      const now = new Date().toISOString();

      if (!gate.ready) {
        // Upsert exec_queue as blocked.
        await db
          .insert(schema.execQueue)
          .values({
            id: `${id.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
            workItemId: id,
            priority: 0,
            status: "blocked",
            currentStage: item.currentStageName ?? "",
            enqueuedAt: now,
            startedAt: null,
            blockedBy: JSON.stringify(
              gate.blockedBy.map((d) => ({ id: d.id, itemKey: d.itemKey })),
            ),
            ownerEmail: ownerEmail!,
            orgId,
          })
          .onConflictDoUpdate({
            target: schema.execQueue.workItemId,
            set: {
              status: "blocked",
              blockedBy: JSON.stringify(
                gate.blockedBy.map((d) => ({ id: d.id, itemKey: d.itemKey })),
              ),
            },
          });

        // Update work_items.status to blocked.
        await db
          .update(schema.workItems)
          .set({ status: "blocked", updatedAt: now })
          .where(eq(schema.workItems.id, id));

        // Write activity log.
        await db.insert(schema.activities).values({
          id: `act_block_${id.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
          workItemId: id,
          actorKind: "agent",
          actorName: "智能体",
          eventType: "等待依赖",
          payload: JSON.stringify({
            blockedBy: gate.blockedBy.map((d) => d.itemKey),
          }),
          createdAt: now,
          ownerEmail: ownerEmail!,
          orgId,
        });

        return {
          workItemId: id,
          ok: true,
          status: "blocked",
          blockedBy: gate.blockedBy.map((d) => d.itemKey),
        };
      }

      // ── F5 pre-dispatch scale gate (shared with single dispatch) ────────────
      // Same resolveScaleGate helper the single-item action uses (02 §3.10).
      // An over-scale item is SKIPPED per-item (reason=scale-exceeded) — it
      // never aborts the rest of the wave/batch — unless the human overrode it
      // batch-wide (overrideScale) or by id (overrideScaleIds). A skip writes
      // NO state (mirrors the single-dispatch zero-residue reject); an override
      // logs scale.overridden after the dispatch succeeds (below).
      const { estimate: scaleEstimate, exceeded: scaleExceeded } =
        resolveScaleGate(item);
      const scaleOverridden =
        scaleExceeded && (args.overrideScale || overrideScaleIdSet.has(id));
      if (scaleExceeded && !scaleOverridden) {
        return {
          workItemId: id,
          ok: false,
          skipped: true,
          reason: "scale-exceeded",
          estimate: scaleEstimate,
          error:
            "规模超过单节点阈值,已跳过(建议 split-work-item 或传 override)",
        };
      }

      const baseBranch = gate.chainedBranch || project.defaultBranch || "main";

      // F9: same tags enrichment as the single-item dispatch path (see
      // dispatch-to-orchestrator.ts) — the batch path must not fork here
      // either, or batch-dispatched items would never get a correctly-scoped
      // writeback callback.
      const tags: Record<string, string> = {
        source: "tracker",
        item_id: item.id,
        owner_email: ownerEmail,
      };
      if (orgId) tags.org_id = orgId;
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
          baseBranch,
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

        // F3 (T-F3-19, SDLC-063 批量路径): identical to the single-item
        // dispatch action — dispatch records ONLY that the item was handed
        // to the orchestrator (`execState='dispatched'`) and NEVER advances
        // `currentStageName`. Business-stage progression is exclusively
        // driven by the evidence-backed writeback channel or the guarded
        // transition-work-item action. The batch path must not fork from the
        // single path here — that fork is exactly how the fake-progress hole
        // would reopen at scale.
        await db
          .update(schema.workItems)
          .set({
            status,
            execState: "dispatched",
            orchestratorThreadId: threadId,
            orchestratorTaskId: result.taskId ?? null,
            orchestratorWorkspaceId: result.workspaceId ?? null,
            dispatchedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.workItems.id, item.id));

        // F8 (回链完整性): the batch path must not fork from the single-item
        // dispatch path here either — same reasoning as the execState/stage
        // write above (T-F3-19's "no fork" precedent). Without this, batch-
        // dispatched items would have zero run history in get-work-item.runs.
        await recordDispatchRun(db, {
          workItemId: item.id,
          threadId,
          ownerEmail: ownerEmail!,
          orgId,
          dispatchedAt: now,
        });

        // F5: a human explicitly overrode this item's split-required verdict —
        // never silent (P13). Same scale.overridden shape as single dispatch.
        if (scaleOverridden) {
          await db.insert(schema.activities).values({
            id: `act_scaleov_${id.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
            workItemId: id,
            actorKind: actor.kind,
            actorName: ownerEmail!,
            eventType: "scale.overridden",
            payload: JSON.stringify({ estimate: scaleEstimate }),
            createdAt: now,
            ownerEmail: ownerEmail!,
            orgId,
          });
        }

        return {
          workItemId: id,
          ok: true,
          status,
          execState: "dispatched",
          currentStageName: item.currentStageName,
          threadId,
          taskId: result.taskId ?? null,
          queuePosition: result.queuePosition ?? null,
          scaleOverridden: scaleOverridden || undefined,
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
    // F5: over-scale skips are reported separately — neither dispatched nor a
    // hard failure (the caller can re-issue with overrideScale/overrideScaleIds
    // or split them first).
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.length - dispatched - skipped;
    return {
      requested: ids.length,
      dispatched,
      skipped,
      failed,
      results,
    };
  },
});
