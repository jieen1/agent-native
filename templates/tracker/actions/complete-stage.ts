import { defineAction } from "@agent-native/core";
import { getRequestUserEmail, getRequestOrgId } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

// Complete a stage on a work item: find the stage row, set its stageStatus to
// "已完成", record completedAt, and write an activity row. Does NOT advance
// currentStageName — call trigger-stage for the next stage separately.
export default defineAction({
  description:
    "Mark a named stage on a work item as completed (stageStatus → 已完成). " +
    "Optionally attach a verdict JSON blob and delivery item list. " +
    "Call trigger-stage for the next stage after this.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item whose stage to complete"),
    stageName: z.string().min(1).describe("Stage name (e.g. 分析, 设计, 实施, 测试, 验收, 交付)"),
    verdict: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional verdict object (e.g. { passed: true, notes: '...' })"),
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
    const VALID_STAGES = ["待办", "分析", "设计", "实施", "测试", "验收", "交付"];
    if (!VALID_STAGES.includes(args.stageName))
      throw new Error(`Invalid stage: ${args.stageName}`);

    // Confirm the work item is owned / visible
    const item = (
      await db
        .select()
        .from(schema.workItems)
        .where(and(eq(schema.workItems.id, args.workItemId), ownerScope(schema.workItems)))
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
    if (!stage) throw new Error(`Stage '${args.stageName}' not found — call trigger-stage first`);

    const verdictStr = args.verdict ? JSON.stringify(args.verdict) : null;
    const deliveryItemsStr = args.deliveryItems
      ? JSON.stringify(args.deliveryItems)
      : stage.deliveryItems ?? "[]";

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

    // When the final 交付 stage completes, mark the work item as done
    if (args.stageName === "交付") {
      await db
        .update(schema.workItems)
        .set({ status: "done", updatedAt: now })
        .where(eq(schema.workItems.id, args.workItemId));
    }

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

    return {
      workItemId: args.workItemId,
      stageName: args.stageName,
      stageId: stage.id,
      stageStatus: "已完成",
      completedAt: now,
    };
  },
});
