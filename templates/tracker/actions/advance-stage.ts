import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { computeItemKeyDisplays } from "../server/lib/item-key-display.js";
import {
  actorFromCaller,
  type ActorKind,
} from "../server/lib/transition-guard.js";
import { validateDependencyGraph } from "../shared/graph-validation.js";

const FULL_STAGE_ORDER = [
  "待办",
  "分析",
  "设计",
  "实施",
  "测试",
  "验收",
  "交付",
] as const;

// F3 (T-F3-18): the writeback/advance channel is capped BELOW 交付. Per 02 §8,
// 「人工完成(任意→交付)」 is human-only through the guarded
// transition-work-item action (evidence: commit/links), and done is only
// reachable from 待人工评审 through the same action. advance-stage may move
// an item up to 验收 and no further — advancing INTO 交付 here is refused.
const GUARDED_FINAL_STAGE = "交付";

// ── Shared helper: advance a single work item one stage ──────────────────────

interface AdvanceOneResult {
  noop?: boolean;
  reason?: string;
  blocked?: boolean;
  missing?: string[];
  workItemId?: string;
  stageName?: string;
}

async function advanceOneItem(
  db: ReturnType<typeof getDb>,
  item: any,
  argsFromStage: string,
  expectedRunId?: string,
  ownerEmail: string = "",
  orgId: string | null = null,
  actorKind: ActorKind = "system",
): Promise<AdvanceOneResult> {
  const now = new Date().toISOString();

  // --- Idempotency checks ---
  if (item.currentStageName !== argsFromStage) {
    return { noop: true, reason: "stage-mismatch" };
  }
  if (
    expectedRunId &&
    item.orchestratorRunId &&
    item.orchestratorRunId !== expectedRunId
  ) {
    return { noop: true, reason: "run-id-mismatch" };
  }

  // --- Determine stage order (plannedStages or fallback) ---
  let stageOrder: string[];
  try {
    stageOrder = Array.isArray(item.plannedStages)
      ? item.plannedStages
      : JSON.parse(item.plannedStages || "[]");
  } catch {
    stageOrder = [];
  }
  if (stageOrder.length === 0) {
    stageOrder = [...FULL_STAGE_ORDER];
  }

  const idx = stageOrder.indexOf(argsFromStage);
  if (idx === -1 || idx >= stageOrder.length - 1) {
    return { noop: true, reason: "no-next-stage" };
  }
  const nextStage = stageOrder[idx + 1];

  // --- F3 (T-F3-18): 交付 is guarded — not reachable via this channel ---
  // Advancing INTO 交付 (and the old `status="done"` side effect that came
  // with it) is refused; the human escape hatch is transition-work-item
  // (target=交付, evidence required), and done is only reachable from
  // 待人工评审 through the same guarded action.
  if (nextStage === GUARDED_FINAL_STAGE) {
    return {
      noop: true,
      reason: "delivery-guarded",
      workItemId: item.id,
    };
  }

  // --- Gate criteria check (config for the CURRENT stage = fromStage) ---
  // Fetch project's stageGateConfig
  const projectRows = await db
    .select({ stageGateConfig: schema.projects.stageGateConfig })
    .from(schema.projects)
    .where(
      and(eq(schema.projects.id, item.projectId), ownerScope(schema.projects)),
    )
    .limit(1);
  const gateConfigRaw = projectRows[0]?.stageGateConfig ?? "{}";
  let gateConfig: Record<string, any> = {};
  try {
    gateConfig = JSON.parse(gateConfigRaw);
  } catch {
    gateConfig = {};
  }

  const criteria = gateConfig[argsFromStage];
  if (criteria) {
    const missing: string[] = [];
    const sprintId = item.sprintId;

    // requireArtifacts check
    if (criteria.requireArtifacts && criteria.requireArtifacts.length > 0) {
      if (!sprintId) {
        // No sprint — all required artifacts are missing
        for (const key of criteria.requireArtifacts) {
          missing.push(`产物缺失: ${key}`);
        }
      } else {
        for (const key of criteria.requireArtifacts) {
          const artifact = (
            await db
              .select()
              .from(schema.sprintArtifacts)
              .where(
                and(
                  ownerScope(schema.sprintArtifacts),
                  eq(schema.sprintArtifacts.sprintId, sprintId),
                  eq(schema.sprintArtifacts.docKey, key),
                ),
              )
              .limit(1)
          )[0];
          if (!artifact) {
            missing.push(`产物缺失: ${key}`);
          }
        }
      }
    }

    // requireApproval check
    if (criteria.requireApproval) {
      if (!sprintId) {
        missing.push(`审批未通过: ${criteria.requireApproval}`);
      } else {
        const approval = (
          await db
            .select()
            .from(schema.approvals)
            .where(
              and(
                ownerScope(schema.approvals),
                eq(schema.approvals.sprintId, sprintId),
                eq(schema.approvals.gateKey, criteria.requireApproval),
                eq(schema.approvals.status, "approved"),
                isNull(schema.approvals.staleAt),
              ),
            )
            .limit(1)
        )[0];
        if (!approval) {
          missing.push(`审批未通过: ${criteria.requireApproval}`);
        }
      }
    }

    // requireGraphValid check
    if (criteria.requireGraphValid) {
      const scopeFilter = sprintId
        ? eq(schema.workItems.sprintId, sprintId)
        : eq(schema.workItems.projectId, item.projectId);

      const items = (await db
        .select({
          id: schema.workItems.id,
          projectId: schema.workItems.projectId,
          itemKey: schema.workItems.itemKey,
        })
        .from(schema.workItems)
        .where(and(ownerScope(schema.workItems), scopeFilter))
        .limit(2000)) as { id: string; projectId: string; itemKey: string }[];

      // F8: itemKey 消歧(读路径) — see validate-dependency-graph.ts (same
      // check, invoked inline here for the requireGraphValid gate).
      const displays = await computeItemKeyDisplays(db, items);
      const nodes = items.map((it) => ({
        id: it.id,
        itemKey: displays.get(it.id) || it.itemKey || it.id,
      }));

      let edges: { fromId: string; toId: string }[] = [];
      if (nodes.length > 0) {
        const ids = nodes.map((n) => n.id);
        const links = (await db
          .select({
            fromItemId: schema.links.fromItemId,
            toItemId: schema.links.toItemId,
          })
          .from(schema.links)
          .where(
            and(
              ownerScope(schema.links),
              eq(schema.links.linkType, "blocked-by"),
              inArray(schema.links.fromItemId, ids),
              inArray(schema.links.toItemId, ids),
            ),
          )
          .limit(5000)) as { fromItemId: string; toItemId: string }[];
        edges = links.map((l) => ({ fromId: l.fromItemId, toId: l.toItemId }));
      }

      const graphResult = validateDependencyGraph(nodes, edges);
      if (graphResult.errors.length > 0) {
        missing.push(
          `依赖图存在错误: ${graphResult.errors.map((e) => e.message).join("; ")}`,
        );
      }
    }

    if (missing.length > 0) {
      return { blocked: true, missing };
    }
  }

  // --- Gate passed: complete current stage, trigger next stage ---

  // Complete current stage row (if it exists)
  const currentStageRow = (
    await db
      .select()
      .from(schema.stages)
      .where(
        and(
          eq(schema.stages.workItemId, item.id),
          eq(schema.stages.stageName, argsFromStage),
        ),
      )
      .limit(1)
  )[0];
  if (currentStageRow) {
    await db
      .update(schema.stages)
      .set({
        stageStatus: "已完成",
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.stages.id, currentStageRow.id));
  }

  // Upsert next stage row (trigger logic)
  const existingNextStage = (
    await db
      .select()
      .from(schema.stages)
      .where(
        and(
          eq(schema.stages.workItemId, item.id),
          eq(schema.stages.stageName, nextStage),
        ),
      )
      .limit(1)
  )[0];

  if (existingNextStage) {
    await db
      .update(schema.stages)
      .set({
        stageStatus: "执行中",
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.stages.id, existingNextStage.id));
  } else {
    const newStageId = `stage_${item.id.slice(0, 4)}_${nextStage}_${now.replace(/\D/g, "").slice(0, 14)}`;
    await db.insert(schema.stages).values({
      id: newStageId,
      workItemId: item.id,
      stageName: nextStage,
      stageStatus: "执行中",
      deliveryItems: "[]",
      verdict: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });
  }

  // Update work item's current stage. F3 (T-F3-18): the old
  // `isFinalDelivery → status="done"` side effect is REMOVED — this channel
  // never writes done (and never reaches 交付, guarded above); done is
  // exclusively written by transition-work-item.
  await db
    .update(schema.workItems)
    .set({
      currentStageName: nextStage,
      status: "running",
      updatedAt: now,
    })
    .where(eq(schema.workItems.id, item.id));

  // Activity log. actorKind is the REAL invoking actor (agent tool-loop
  // calls record as "agent"), not a hardcoded "human" — the activity feed's
  // actor badge must be trustworthy (F3, T-F3-18).
  // HOTFIX: the id above is DETERMINISTIC (item id + from/to stage + `now`).
  // When the F9 writeback sweep retries a run it can regenerate the same id;
  // the first attempt's row already exists, so a bare INSERT would throw a
  // tracker_activities primary-key violation and leave v3_runs.writeback_status
  // stuck at 'pending' forever. onConflictDoNothing() makes the insert
  // idempotent — a retried writeback that already wrote this activity is a
  // no-op, not a failure. (activities PK is `id`, so no explicit target needed.)
  await db
    .insert(schema.activities)
    .values({
      id: `act_adv_${item.id.slice(0, 6)}_${argsFromStage}_to_${nextStage}_${now.replace(/\D/g, "").slice(0, 14)}`,
      workItemId: item.id,
      actorKind,
      actorName: ownerEmail,
      eventType: "推进",
      payload: JSON.stringify({ fromStage: argsFromStage, toStage: nextStage }),
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    })
    .onConflictDoNothing();

  return { workItemId: item.id, stageName: nextStage };
}

// ── Action definition ─────────────────────────────────────────────────────────

export default defineAction({
  description:
    "Advance a work item to the next stage (based on its plannedStages). " +
    "Checks per-project gate criteria (artifacts, approvals, graph validity) " +
    "before transitioning. Supports scope='item' (single) or scope='sprint' (batch).",
  schema: z.object({
    scope: z.enum(["item", "sprint"]),
    id: z
      .string()
      .min(1)
      .describe("workItemId when scope=item, sprintId when scope=sprint"),
    fromStage: z
      .string()
      .min(1)
      .describe("Expected current stage — mismatch is a no-op"),
    expectedRunId: z
      .string()
      .optional()
      .describe(
        "If provided and item.orchestratorRunId is set but differs, no-op",
      ),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;
    // Real invoking actor for the activity trail (agent tool calls → "agent").
    const actorKind = actorFromCaller(ctx?.caller, ownerEmail).kind;

    const db = getDb();

    if (args.scope === "item") {
      // scope=item: single work item advance
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

      const result = await advanceOneItem(
        db,
        item,
        args.fromStage,
        args.expectedRunId,
        ownerEmail,
        orgId,
        actorKind,
      );

      // F9 (阶段起点契约, T-F9-02): a scope=item call is how the writeback
      // channel drives 实施→测试→验收 — its `fromStage` is an EXPECTATION
      // ("this item should currently be at 实施/测试"), not a search filter.
      // When that expectation doesn't hold (item drifted/was never moved into
      // 实施 — dispatch itself never advances the stage, SDLC-063), the guard
      // above already no-ops (zero stage/status writes — "不搬工作项进实施").
      // What's missing without this block is VISIBILITY: silence here would
      // make "阶段起点契约" an untestable prose-only claim. Write a dedicated
      // activity event so S10 / the item's own activity feed can surface the
      // mismatch for human triage, instead of the reconciler's forward
      // advance just silently vanishing. Scope=sprint's batch cascade
      // deliberately keeps the existing silent-skip behavior (a sprint-wide
      // advance naturally only applies to the subset of items actually at
      // fromStage — that's expected, not an anomaly worth an event each).
      if (result.noop && result.reason === "stage-mismatch") {
        const now = new Date().toISOString();
        // HOTFIX: deterministic id (item id + `now`) — a retried writeback
        // replaying the same payload/timestamp regenerates it. Guard the insert
        // so the retry is a no-op instead of a primary-key conflict that wedges
        // writeback_status at 'pending'. (activities PK is `id`.)
        await db
          .insert(schema.activities)
          .values({
            id: `act_wbmismatch_${item.id.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
            workItemId: item.id,
            actorKind,
            actorName: ownerEmail,
            eventType: "writeback.stage-mismatch",
            payload: JSON.stringify({
              expectedFromStage: args.fromStage,
              actualStage: item.currentStageName,
              expectedRunId: args.expectedRunId ?? null,
            }),
            createdAt: now,
            ownerEmail,
            orgId,
            visibility: "private",
          })
          .onConflictDoNothing();
      }

      return result;
    }

    // scope=sprint: batch advance all items in the sprint
    const sprint = (
      await db
        .select()
        .from(schema.sprints)
        .where(and(eq(schema.sprints.id, args.id), ownerScope(schema.sprints)))
        .limit(1)
    )[0];
    if (!sprint) throw new Error("Sprint not found or not accessible");

    const items = await db
      .select()
      .from(schema.workItems)
      .where(
        and(
          eq(schema.workItems.sprintId, args.id),
          ownerScope(schema.workItems),
        ),
      )
      .limit(2000);

    const now = new Date().toISOString();

    // ── Single-active-sprint assertion (M1-7) ──────────────────────────────
    // Only when advancing from "设计" (targeting "实施"): ensure no other
    // sprint in the same project is already in an active phase.
    if (args.fromStage === "设计") {
      const allSprints = await db
        .select()
        .from(schema.sprints)
        .where(
          and(
            eq(schema.sprints.projectId, sprint.projectId),
            ownerScope(schema.sprints),
          ),
        );
      const ACTIVE_PHASES = ["executing", "verifying", "auditing", "promoting"];
      const conflict = allSprints.find(
        (s) => s.id !== args.id && s.phase && ACTIVE_PHASES.includes(s.phase),
      );
      if (conflict) {
        throw new Error(
          `已有活跃 sprint 「${conflict.name}」处于 ${conflict.phase} 阶段，请先完成或关闭该 sprint 后再推进本 sprint 至实施阶段`,
        );
      }
      // Mark current sprint as executing before cascading work items
      await db
        .update(schema.sprints)
        .set({ phase: "executing", updatedAt: now })
        .where(eq(schema.sprints.id, args.id));
    }

    const cascaded: { workItemId: string; ok: boolean; error?: string }[] = [];

    for (const item of items) {
      try {
        const result = await advanceOneItem(
          db,
          item,
          args.fromStage,
          args.expectedRunId,
          ownerEmail,
          orgId,
          actorKind,
        );
        if (result.blocked) {
          cascaded.push({
            workItemId: item.id,
            ok: false,
            error: `blocked: ${(result.missing ?? []).join("; ")}`,
          });
        } else if (result.noop && result.reason === "stage-mismatch") {
          // Item isn't currently at fromStage — not a candidate for this
          // cascade call, not a failure. Skip silently.
          continue;
        } else if (result.noop) {
          cascaded.push({
            workItemId: item.id,
            ok: false,
            error: `noop: ${result.reason ?? "unknown"}`,
          });
        } else {
          cascaded.push({ workItemId: item.id, ok: true });
        }
      } catch (e) {
        const errStr = String(e);
        // Write failure activity (real actor, not hardcoded "human")
        // HOTFIX: deterministic id (item id + `now`) — same idempotency guard
        // as the other activity inserts so a retried sweep doesn't throw a
        // primary-key conflict here. (activities PK is `id`.)
        await db
          .insert(schema.activities)
          .values({
            id: `act_adv_fail_${item.id.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
            workItemId: item.id,
            actorKind,
            actorName: ownerEmail,
            eventType: "推进失败",
            payload: JSON.stringify({ error: errStr }),
            createdAt: now,
            ownerEmail,
            orgId,
            visibility: "private",
          })
          .onConflictDoNothing();
        cascaded.push({ workItemId: item.id, ok: false, error: errStr });
      }
    }

    // Refresh sprint updatedAt
    await db
      .update(schema.sprints)
      .set({ updatedAt: now })
      .where(eq(schema.sprints.id, args.id));

    return { cascaded };
  },
});
