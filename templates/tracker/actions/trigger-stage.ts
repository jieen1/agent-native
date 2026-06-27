import { defineAction } from "@agent-native/core";
import { getRequestUserEmail, getRequestOrgId } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

// Trigger a stage on a work item: find or create the stage row, set it to
// "执行中", mark startedAt, and update the work item's current stage to this
// one with status "running". Insert an audit activity row.
export default defineAction({
  description:
    "Trigger a named stage on a work item (creates the stage row if it does not " +
    "exist yet), set its status to 执行中, and update the work item to running.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item to trigger a stage on"),
    stageName: z.string().min(1).describe("Stage name (e.g. 分析, 设计, 实施, 测试, 验收, 交付)"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    const now = new Date().toISOString();
    const VALID_STAGES = ['待办','分析','设计','实施','测试','验收','交付'];
    if (!VALID_STAGES.includes(args.stageName)) throw new Error(`Invalid stage: ${args.stageName}`);


    // --- Confirm the work item is owned / visible ---
    const item = (
      await db
        .select()
        .from(schema.workItems)
        .where(and(eq(schema.workItems.id, args.workItemId), ownerScope(schema.workItems)))
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found or not accessible");

    // --- Upsert the stage row ---
    const existingStage = (
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

    if (existingStage) {
      // Stage already exists — just update its status to 执行中
      await db
        .update(schema.stages)
        .set({
          stageStatus: "执行中",
          startedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.stages.id, existingStage.id));
    } else {
      // Create a new stage row
      const stageId = existingStage?.id || "";
      const newStageId =
        existingStage && existingStage.id
          ? existingStage.id
          : `stage_${args.workItemId.slice(0, 4)}_${args.stageName.slice(0, 4)}_${now.replace(/[:.]/g, "").slice(0, 8)}`;

      await db.insert(schema.stages).values({
        id: newStageId,
        workItemId: args.workItemId,
        stageName: args.stageName,
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

    // --- Update the work item ---
    await db
      .update(schema.workItems)
      .set({
        currentStageName: args.stageName,
        status: "running",
        updatedAt: now,
      })
      .where(eq(schema.workItems.id, args.workItemId));

    // --- Insert an activity row ---
    await db.insert(schema.activities).values({
      id: `act_trigger_${args.workItemId.slice(0, 8)}_${now.replace(/[:.]/g, "").slice(0, 8)}`,
      workItemId: args.workItemId,
      actorKind: "human",
      actorName: ownerEmail,
      eventType: "触发",
      payload: JSON.stringify({ stageName: args.stageName }),
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    // Look up the stage id we just upserted
    const finalStage = (
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

    return {
      workItemId: args.workItemId,
      stageName: args.stageName,
      stageId: finalStage?.id ?? null,
    };
  },
});
