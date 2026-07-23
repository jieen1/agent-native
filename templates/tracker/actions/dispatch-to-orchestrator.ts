import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { resolveDispatchPayload } from "../server/lib/brief-payload.js";
import { resolveDispatchGate } from "../server/lib/dispatch-gate.js";
import { callOrchestratorTool } from "../server/lib/orchestrator-client.js";
import {
  resolveScaleGate,
  scaleExceededError,
} from "../server/lib/scale-gate.js";
import { assertSchedulerNotPaused } from "../server/lib/scheduler-gate.js";
import { actorFromCaller } from "../server/lib/transition-guard.js";
import { recordDispatchRun } from "../server/lib/work-item-runs.js";
import { resolveWorkflowRule } from "../server/lib/workflow-routing.js";

// Dispatch a work item to the orchestrator's CC brain. Sends a STRUCTURED MCP
// `tools/call` for `brain-send` with the requirement + the project's repo/branch
// context + tracker tags. The brain provisions a workspace, analyzes the
// requirement itself, hands the actual coding to the local vLLM `sdlc-dev`
// workflow (brain only analyzes/reviews/commits), monitors, then
// commits/pushes a PR. We store the returned threadId and set the item to
// `dispatched`.
export default defineAction({
  description:
    "Dispatch a work item to the orchestrator brain for autonomous execution. " +
    "Carries the work item's requirement plus the project's repo/branch and " +
    "tracker tags, returns the brain threadId, and marks the item dispatched.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item to dispatch"),
    monitorIntervalSec: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Periodic drift-check cadence (seconds) for the orchestrator brain " +
          "monitor. Omit → server default (120); 0 → event-only (no timer wakes).",
      ),
    overrideScale: z
      .boolean()
      .optional()
      .describe(
        "Human escape hatch (02 §3.10 决策序①): dispatch anyway even though " +
          "scale_estimate.verdict='split-required'. Logs a scale.overridden " +
          "activity with the estimate snapshot — never silent.",
      ),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();

    // Real, persisted scheduler pause gate (03-tracker.md §8) — throws BEFORE
    // any orchestrator call so a paused scheduler has a real effect on every
    // dispatch entry point (work-item detail page's manual dispatch AND the
    // queue page's "立即派发"), not just a queue-page banner. On reject, also
    // note the reason on this item's exec_queue row (if it has one) so the
    // queue table's "等待健康门" group shows WHY, not just that it's stuck.
    try {
      await assertSchedulerNotPaused(args.workItemId);
    } catch (err) {
      try {
        const rejectedAt = new Date().toISOString();
        await db
          .update(schema.execQueue)
          .set({
            healthCheckLog: JSON.stringify({
              reason: "调度器已暂停",
              at: rejectedAt,
            }),
            waitingOn: JSON.stringify({
              type: "health",
              reason: "调度器已暂停",
            }),
          })
          .where(eq(schema.execQueue.workItemId, args.workItemId));
      } catch {
        // Non-fatal — the real scheduler-paused error below still propagates.
      }
      throw err;
    }

    const item = (
      await db
        .select()
        .from(schema.workItems)
        .where(
          and(
            eq(schema.workItems.id, args.workItemId),
            ownerScope(schema.workItems),
          ),
        )
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found or not accessible");

    const project = (
      await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, item.projectId))
        .limit(1)
    )[0];
    if (!project) throw new Error("Owning project not found");
    if (!project.gitRemote) {
      throw new Error(
        "Project has no git remote configured — set one on the project before dispatching.",
      );
    }

    // ── Dependency gate check ─────────────────────────────────────────────────
    const gate = await resolveDispatchGate(
      db,
      args.workItemId,
      ownerEmail,
      orgId,
    );
    const now = new Date().toISOString();

    if (!gate.ready) {
      const blockedByJson = JSON.stringify(
        gate.blockedBy.map((d) => ({ id: d.id, itemKey: d.itemKey })),
      );
      const waitingOnJson = JSON.stringify({
        type: "dependency",
        items: gate.blockedBy,
      });
      // Upsert the exec_queue row as blocked.
      await db
        .insert(schema.execQueue)
        .values({
          id: `${args.workItemId.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
          workItemId: args.workItemId,
          priority: 0,
          status: "blocked",
          currentStage: item.currentStageName ?? "",
          enqueuedAt: now,
          startedAt: null,
          blockedBy: blockedByJson,
          waitingOn: waitingOnJson,
          ownerEmail,
          orgId,
        })
        .onConflictDoUpdate({
          target: schema.execQueue.workItemId,
          set: {
            status: "blocked",
            blockedBy: blockedByJson,
            waitingOn: waitingOnJson,
          },
        });

      // Update work_items.status to blocked (do NOT change currentStageName).
      await db
        .update(schema.workItems)
        .set({ status: "blocked", updatedAt: now })
        .where(eq(schema.workItems.id, args.workItemId));

      // Write an activity log entry.
      await db.insert(schema.activities).values({
        id: `act_block_${args.workItemId.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
        workItemId: args.workItemId,
        actorKind: "agent",
        actorName: "智能体",
        eventType: "等待依赖",
        payload: JSON.stringify({
          blockedBy: gate.blockedBy.map((d) => d.itemKey),
        }),
        createdAt: now,
        ownerEmail,
        orgId,
      });

      return {
        workItemId: args.workItemId,
        status: "blocked",
        blockedBy: gate.blockedBy.map((d) => d.itemKey),
      };
    }

    // ── F5 pre-dispatch scale gate (02 §3.10 拆分契约) ──────────────────────
    // Shared with bulk-dispatch via resolveScaleGate (server/lib/scale-gate.ts)
    // — the SINGLE source of truth for the scale contract across both dispatch
    // paths, so the gate can never again live in only one of them (the F3-era
    // bulk-path blind spot). Reads scale_estimate (persisted by
    // estimate-brief-scale.ts) or computes it on the fly. verdict='split-
    // required' without an explicit human overrideScale rejects BEFORE any
    // state write — mirrors the zero-state-residue contract of the dependency
    // gate above (T-F5-03: execState stays null/queued, zero activity residue).
    const { estimate: scaleEstimate, exceeded: scaleExceeded } =
      resolveScaleGate(item);
    if (scaleExceeded && !args.overrideScale) {
      throw scaleExceededError(scaleEstimate);
    }

    // Determine baseBranch: use chainedBranch if available, otherwise project default.
    const baseBranch = gate.chainedBranch || project.defaultBranch || "main";

    // F9: carry ownerEmail/orgId so the orchestrator reconciler's writeback
    // channel (out of tracker's scope — server/tracker-client.ts) can mint a
    // correctly-scoped A2A JWT for its callback into the tracker's guarded
    // actions (advance-stage's ownerScope() + this item's own tenant) once the
    // run reaches a terminal state. org_id is omitted when the item has no
    // org (single-tenant/local mode) — brain-send's tags are
    // Record<string,string>, so a null/undefined orgId must not be forwarded.
    //
    // MUST be the ITEM's own org (item.orgId), NOT the dispatching session's
    // ambient org (the `orgId` local above, from getRequestOrgId()). Root
    // cause of a real production incident: ownerScope() above (line ~100)
    // admits this SELECT via an OR of ownerEmail-match OR org-match, so a
    // caller whose live session org differs from this item's own org can
    // still find + dispatch it (matched via ownerEmail). The writeback
    // channel's sentinel JWT, though, authenticates as a fixed service
    // identity whose `sub` never equals a real user's ownerEmail — it can
    // ONLY be admitted via the org branch (see tracker-client.ts's
    // mintWritebackJwt / writeback-exec-state.ts's ownerScope() call). Tagging
    // the run with the caller's ambient org instead of the item's real org
    // silently mints a JWT for the WRONG tenant, so every writeback callback
    // permanently 404s with "Work item not found" — and because the outbox
    // sweep retries forever (v3-reconciler.ts drainWritebackOutbox has no
    // permanent-failure exit), this became an unbounded retry storm.
    const itemOrgId = item.orgId ?? orgId;
    const tags: Record<string, string> = {
      source: "tracker",
      item_id: item.id,
      owner_email: ownerEmail,
    };
    if (itemOrgId) tags.org_id = itemOrgId;

    // R4a.3 L1 — deterministic pre-selection routing (design authority:
    // docs/sdlc-product-design/r4-workflow-families-planning-skills.md §4.4
    // first bullet). This is a SUGGESTION, not a mandate — the brain remains
    // free to author its own DAG or deviate (L2 leaves a trace; see
    // writeback-run-meta.ts's optional `templateDeviation` field).
    let itemTags: string[] = [];
    let itemNature: string[] = [];
    try {
      itemTags = JSON.parse(item.tags || "[]");
    } catch {
      itemTags = [];
    }
    try {
      itemNature = JSON.parse(item.nature || "[]");
    } catch {
      itemNature = [];
    }
    const workflowRule = await resolveWorkflowRule(db, {
      projectId: project.id,
      itemType: item.type,
      tags: itemTags,
      natureTags: itemNature,
      inSprint: !!item.sprintId,
    });
    tags.suggestedTemplate = workflowRule.templateName;
    tags.ruleId = workflowRule.ruleId;

    // R4b.3 (§5.5 payload contract): inject the item's OWN structured
    // sprint-studio brief — never another item's, never tech-design/
    // sprint-doc full text — as this dispatch's suggestedInputs, keyed by
    // the L1-suggested template above. Best-effort: {} whenever the item has
    // no sprint or no brief has been extracted yet, so a pre-Studio dispatch
    // is byte-for-byte unchanged from before (raw description prose only).
    const briefPayload = item.sprintId
      ? await resolveDispatchPayload(db, {
          sprintId: item.sprintId,
          itemKey: item.itemKey,
          templateName: workflowRule.templateName,
        })
      : {};

    const requirement = item.description?.trim() || item.title;
    const message =
      `Work item ${item.id} (${project.key}) — "${item.title}".\n\n` +
      `Requirement:\n${requirement}\n\n` +
      `Work in the checked-out workspace. Follow the orchestrating-v3 skill. Coding/development work DEFAULTS to the configurable development engine: analyze the requirement and the existing code yourself, then after workspaceCreate call workflowRun with template 'sdlc-dev' and inputs { spec, workspaceId, devEngine } to hand the actual coding to the develop node. The dev engine defaults to the local vLLM but is configurable — pass a devEngine when the item or project specifies one. You (the brain) analyze, review the resulting git diff, fix anything wrong, and commit — rather than writing the business code yourself. Monitor by polling, then workspaceCommitPush to open a PR. When done, report the run id and the PR url.`;

    // brain-send (additive `tags` param) instructs the brain to attach these
    // tags to every workflowRun/workspaceCreate/spawnOnce so the activity is
    // reassemblable via runsList/spawnList { tagMatch }.
    const { data } = await callOrchestratorTool(ownerEmail, "brain-send", {
      message,
      repo: project.gitRemote,
      baseBranch,
      tags,
      // L1 suggested inputs (§4.4) merged with the R4b.3 §5.5 brief payload
      // (briefPayload wins on key overlap — it's the more specific, item-own
      // content) — rides brain-send's dedicated `suggestedInputs` field
      // rather than the string-only `tags`.
      ...(Object.keys(workflowRule.defaultInputs).length > 0 ||
      Object.keys(briefPayload).length > 0
        ? {
            suggestedInputs: { ...workflowRule.defaultInputs, ...briefPayload },
          }
        : {}),
      // Forward the configurable periodic drift-check cadence. Undefined lets
      // the orchestrator apply its env default (BRAIN_MONITOR_INTERVAL_SEC).
      ...(args.monitorIntervalSec !== undefined
        ? { monitorIntervalSec: args.monitorIntervalSec }
        : {}),
    });

    const result = data as { threadId?: string; workspaceId?: string | null };
    const threadId = result?.threadId;
    if (!threadId) {
      throw new Error(
        `Dispatch reached the orchestrator but no threadId was returned: ${JSON.stringify(
          data,
        ).slice(0, 300)}`,
      );
    }

    // F3 (SDLC-063, 派发不推进): dispatch records ONLY that the item has been
    // handed to the orchestrator — it records `execState='dispatched'` (the
    // new v24 column) and NEVER writes `currentStageName`. Business-stage
    // progression is exclusively driven by the F9 evidence-backed
    // reconciler/writeback channel (实施→测试→… via `advance-stage`) or by a
    // human through the guarded `transition-work-item` action. Dispatching
    // twice, dispatching a stale item, or a brain that never delivers must
    // never leave the item looking further along than it is.
    await db
      .update(schema.workItems)
      .set({
        status: "dispatched",
        execState: "dispatched",
        orchestratorThreadId: threadId,
        orchestratorWorkspaceId: result.workspaceId ?? null,
        dispatchedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.workItems.id, item.id));

    // F8 (回链完整性): append-only run history. A redispatch marks the
    // item's prior live row(s) superseded=1 and inserts a fresh row — never
    // overwrites a single slot (SDLC-053). runId/branch are unknown at
    // dispatch time (only threadId is) and get backfilled once the bound DAG
    // run starts and reports its branch (F9's writeback channel).
    await recordDispatchRun(db, {
      workItemId: item.id,
      threadId,
      ownerEmail,
      orgId,
      dispatchedAt: now,
    });

    // F5 (02 §3.10 决策序①): the human explicitly overrode a split-required
    // verdict to dispatch anyway — never silent (P13). Logged only when the
    // override was actually exercised (verdict was split-required AND
    // overrideScale was set), not on every overrideScale:true pass-through.
    if (scaleExceeded && args.overrideScale) {
      const actor = actorFromCaller(ctx?.caller, ownerEmail);
      await db.insert(schema.activities).values({
        id: `act_scaleov_${item.id.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
        workItemId: item.id,
        actorKind: actor.kind,
        actorName: ownerEmail,
        eventType: "scale.overridden",
        payload: JSON.stringify({ estimate: scaleEstimate }),
        createdAt: now,
        ownerEmail,
        orgId,
      });
    }

    return {
      workItemId: item.id,
      threadId,
      workspaceId: result.workspaceId ?? null,
      status: "dispatched",
      execState: "dispatched",
      currentStageName: item.currentStageName,
      dispatchedAt: now,
      monitorIntervalSec: args.monitorIntervalSec ?? null,
      tags,
      scaleOverridden: scaleExceeded && !!args.overrideScale,
    };
  },
});
