import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

// Rollback a stage on a work item: set the current stage status to "已驳回",
// find or create the target stage and set it to "待执行", insert a rollback_log
// row, update the work item's currentStageName, and insert an activity row.
export default defineAction({
  description:
    "Rollback a work item to a previous stage (set current stage to 已驳回, " +
    "set target stage to 待执行, log the rollback), and update the work item's " +
    "current stage.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item to rollback"),
    targetStage: z.string().min(1).describe("Target stage name to rollback to"),
    reason: z.string().optional().describe("Reason for the rollback"),
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
    if (!VALID_STAGES.includes(args.targetStage))
      throw new Error(`Invalid stage: ${args.targetStage}`);

    // --- Confirm the work item is owned / visible ---
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

    // Rollback protection: reject if item is bound to a running/dispatched run
    if (
      item.orchestratorRunId &&
      (item.status === "dispatched" || item.status === "running")
    ) {
      throw new Error(
        "该工作项绑定的运行任务正在执行中，请先取消该运行后再进行回退操作",
      );
    }

    const fromStage = item.currentStageName;
    if (!fromStage) throw new Error("Work item has no current stage");

    // --- Set current stage status to "已驳回" ---
    const currentStage = (
      await db
        .select()
        .from(schema.stages)
        .where(
          and(
            eq(schema.stages.workItemId, args.workItemId),
            eq(schema.stages.stageName, fromStage),
          ),
        )
        .limit(1)
    )[0];

    if (currentStage) {
      await db
        .update(schema.stages)
        .set({
          stageStatus: "已驳回",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.stages.id, currentStage.id));
    }

    // --- Find or create the target stage ---
    const existingTargetStage = (
      await db
        .select()
        .from(schema.stages)
        .where(
          and(
            eq(schema.stages.workItemId, args.workItemId),
            eq(schema.stages.stageName, args.targetStage),
          ),
        )
        .limit(1)
    )[0];

    if (existingTargetStage) {
      // Target stage already exists — set status to "待执行"
      await db
        .update(schema.stages)
        .set({
          stageStatus: "待执行",
          startedAt: null,
          completedAt: null,
          verdict: null,
          updatedAt: now,
        })
        .where(eq(schema.stages.id, existingTargetStage.id));
    } else {
      // Create a new target stage row
      const targetStageId = `stage_${args.workItemId.slice(0, 4)}_${args.targetStage.slice(0, 4)}_${now.replace(/[:.]/g, "").slice(0, 8)}`;

      await db.insert(schema.stages).values({
        id: targetStageId,
        workItemId: args.workItemId,
        stageName: args.targetStage,
        stageStatus: "待执行",
        deliveryItems: "[]",
        verdict: null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        ownerEmail,
        orgId,
        visibility: "private",
      });
    }

    // --- Insert a rollback_log row ---
    await db.insert(schema.rollbackLog).values({
      id: `rollback_${args.workItemId.slice(0, 8)}_${now.replace(/[:.]/g, "").slice(0, 8)}`,
      workItemId: args.workItemId,
      fromStage,
      toStage: args.targetStage,
      reason: args.reason ?? "",
      byKind: "human",
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    // --- Update the work item ---
    await db
      .update(schema.workItems)
      .set({
        currentStageName: args.targetStage,
        updatedAt: now,
      })
      .where(eq(schema.workItems.id, args.workItemId));

    // --- Insert an activity row ---
    await db.insert(schema.activities).values({
      id: `act_rollback_${args.workItemId.slice(0, 8)}_${now.replace(/[:.]/g, "").slice(0, 8)}`,
      workItemId: args.workItemId,
      actorKind: "human",
      actorName: ownerEmail,
      eventType: "回退",
      payload: JSON.stringify({
        fromStage,
        toStage: args.targetStage,
        reason: args.reason ?? "",
      }),
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return {
      workItemId: args.workItemId,
      fromStage,
      toStage: args.targetStage,
    };
  },
});
