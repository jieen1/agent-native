import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import {
  buildStageVocabularyOrder,
  safeParseFlows,
  safeParseObject,
} from "../shared/stage-vocabulary.js";

const STAGE_COLUMNS = {
  id: schema.stages.id,
  workItemId: schema.stages.workItemId,
  stageName: schema.stages.stageName,
  stageStatus: schema.stages.stageStatus,
  deliveryItems: schema.stages.deliveryItems,
  verdict: schema.stages.verdict,
  workflowRunRef: schema.stages.workflowRunRef,
  startedAt: schema.stages.startedAt,
  completedAt: schema.stages.completedAt,
  createdAt: schema.stages.createdAt,
  updatedAt: schema.stages.updatedAt,
} as const;

// List all stages for a work item, ordered by stage name.
//
// Backward compatibility: a project that has configured zero custom stage
// flows (the default — stageFlows = '[]') is ordered by the EXACT SAME
// hardcoded CASE expression as before Stage Configuration existed (待办 →
// 分析 → 设计 → 实施 → 测试 → 验收 → 交付, unknown names last). Only once a
// project has configured a real flow does ordering switch to the derived
// stage-vocabulary order (buildStageVocabularyOrder — shared with
// get-stage-config.ts), so a custom stage name introduced by a flow sorts
// where that flow says it should, instead of always landing last.
export default defineAction({
  description:
    "List all stages for a work item, ordered by the standard execution " +
    "sequence (待办 → 分析 → 设计 → 实施 → 测试 → 验收 → 交付), or by the " +
    "project's configured stage-vocabulary order once custom flows exist.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item to list stages for"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();

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

    const projectRow = (
      await db
        .select({
          stageFlows: schema.projects.stageFlows,
          stageDescriptions: schema.projects.stageDescriptions,
          stageGateConfig: schema.projects.stageGateConfig,
        })
        .from(schema.projects)
        .where(eq(schema.projects.id, item.projectId))
        .limit(1)
    )[0];
    const flows = safeParseFlows(projectRow?.stageFlows);

    let rows;
    if (flows.length === 0) {
      // No custom flows configured — keep today's exact ordering.
      rows = await db
        .select(STAGE_COLUMNS)
        .from(schema.stages)
        .where(eq(schema.stages.workItemId, args.workItemId))
        .orderBy(
          sql`CASE ${schema.stages.stageName}
            WHEN '待办' THEN 1
            WHEN '分析' THEN 2
            WHEN '设计' THEN 3
            WHEN '实施' THEN 4
            WHEN '测试' THEN 5
            WHEN '验收' THEN 6
            WHEN '交付' THEN 7
            ELSE 8
          END`,
        );
    } else {
      const order = buildStageVocabularyOrder(
        flows,
        safeParseObject(projectRow?.stageDescriptions),
        safeParseObject(projectRow?.stageGateConfig),
      );
      const orderIndex = new Map(order.map((name, i) => [name, i]));
      const unordered = await db
        .select(STAGE_COLUMNS)
        .from(schema.stages)
        .where(eq(schema.stages.workItemId, args.workItemId));
      rows = unordered
        .slice()
        .sort(
          (a, b) =>
            (orderIndex.get(a.stageName) ?? order.length) -
            (orderIndex.get(b.stageName) ?? order.length),
        );
    }

    // Parse JSON fields (deliveryItems is a JSON array string; verdict may be null or a JSON object)
    const result = rows.map((row) => ({
      ...row,
      deliveryItems: (() => {
        try {
          return JSON.parse(row.deliveryItems ?? "[]");
        } catch {
          return [];
        }
      })(),
      verdict: row.verdict
        ? (() => {
            try {
              return JSON.parse(row.verdict);
            } catch {
              return null;
            }
          })()
        : null,
    }));

    return result;
  },
});
