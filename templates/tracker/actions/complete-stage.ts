import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { reevaluateBlockedQueue } from "../server/lib/dispatch-gate.js";

// Complete a stage on a work item: find the stage row, set its stageStatus to
// "已完成", record completedAt, and write an activity row. Does NOT advance
// currentStageName — call trigger-stage for the next stage separately.
// F3 (verdict 语义收紧, T-F3-16): when a verdict is attached, `result` is a
// mandatory enum — no more free-form "{ passed: true }" blobs whose shape the
// caller invents. Extra keys (e.g. `notes`) are still allowed via passthrough.
const VerdictSchema = z
  .object({
    result: z.enum(["PASSED", "CHANGES_REQUESTED"]),
  })
  .passthrough();

export default defineAction({
  description:
    "Mark a named stage on a work item as completed (stageStatus → 已完成). " +
    "Optionally attach a verdict (result: PASSED|CHANGES_REQUESTED) and delivery " +
    "item list. Call trigger-stage for the next stage after this. Completing " +
    "the 交付 stage does NOT mark the work item done — call transition-work-item " +
    "(target=done) for that, which requires a human actor + PASSED verdict + " +
    "merge commit (F3 状态迁移守卫).",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item whose stage to complete"),
    stageName: z
      .string()
      .min(1)
      .describe("Stage name (e.g. 分析, 设计, 实施, 测试, 验收, 交付)"),
    verdict: VerdictSchema.optional().describe(
      "Optional verdict object. When provided, `result` is a required enum " +
        "(PASSED | CHANGES_REQUESTED) — extra fields (e.g. notes) are preserved.",
    ),
    deliveryItems: z
      .array(z.string())
      .optional()
      .describe("Optional list of delivery artifact names"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    const now = new Date().toISOString();
    const VALID_STAGES = [
      "待办",
      "分析",
      "设计",
      "实施",
      "测试",
      "验收",
      "交付",
    ];
    if (!VALID_STAGES.includes(args.stageName))
      throw new Error(`Invalid stage: ${args.stageName}`);

    // Confirm the work item is owned / visible
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

    // Find the stage row
    const stage = (
      await db
        .select()
        .from(schema.stages)
        .where(
          and(
            eq(schema.stages.workItemId, args.workItemId),
            eq(schema.stages.stageName, args.stageName),
          ),
        )
        .limit(1)
    )[0];
    if (!stage)
      throw new Error(
        `Stage '${args.stageName}' not found — call trigger-stage first`,
      );

    const verdictStr = args.verdict ? JSON.stringify(args.verdict) : null;
    const deliveryItemsStr = args.deliveryItems
      ? JSON.stringify(args.deliveryItems)
      : (stage.deliveryItems ?? "[]");

    await db
      .update(schema.stages)
      .set({
        stageStatus: "已完成",
        completedAt: now,
        updatedAt: now,
        ...(verdictStr !== null ? { verdict: verdictStr } : {}),
        deliveryItems: deliveryItemsStr,
      })
      .where(eq(schema.stages.id, stage.id));

    // F3 (T-F3-04): completing the 交付 stage NO LONGER writes
    // work_items.status="done" as a side effect — that direct-write channel
    // is exactly the B3 "未评审即 done" hole (SDLC-058). done is now only
    // reachable through transition-work-item(target=done), which requires a
    // human actor + PASSED verdict + a merge commit. The work item's own
    // status is left untouched here; the caller is told where to go next via
    // the return payload's `doneChannel` hint (not an error — the stage
    // completion itself succeeded).
    const doneChannel =
      args.stageName === "交付"
        ? "阶段已完成,但 done 需经 transition-work-item(target=done, 需 PASSED verdict + 合并 commit)"
        : null;

    // Activity log
    await db.insert(schema.activities).values({
      id: `act_cmp_${args.workItemId.slice(0, 6)}_${args.stageName}_${now.replace(/\D/g, "").slice(0, 14)}`,
      workItemId: args.workItemId,
      actorKind: "human",
      actorName: ownerEmail,
      eventType: "完成",
      payload: JSON.stringify({
        stageName: args.stageName,
        verdict: args.verdict ?? null,
      }),
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    // Completing a stage (especially 实施) may clear the dispatch gate for
    // downstream items that were blocked-by this one. Re-evaluate the blocked
    // queue; this is a non-fatal, best-effort side effect.
    await reevaluateBlockedQueue(db, ownerEmail, orgId, args.workItemId);

    return {
      workItemId: args.workItemId,
      stageName: args.stageName,
      stageId: stage.id,
      stageStatus: "已完成",
      completedAt: now,
      doneChannel,
    };
  },
});
