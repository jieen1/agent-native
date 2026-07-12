import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

// List all stages for a work item, ordered by stage name using a CASE expression
// that maps the known stage names to their natural order (待办 → 分析 → 设计 →
// 实施 → 测试 → 验收 → 交付). Each row has deliveryItems and verdict parsed
// from their JSON string form.
export default defineAction({
  description:
    "List all stages for a work item, ordered by the standard execution " +
    "sequence (待办 → 分析 → 设计 → 实施 → 测试 → 验收 → 交付).",
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
        .where(and(eq(schema.workItems.id, args.workItemId), ownerScope(schema.workItems)))
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found or not accessible");

    const rows = await db
      .select({
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
      })
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

    // Parse JSON fields (deliveryItems is a JSON array string; verdict may be null or a JSON object)
    const result = rows.map((row) => ({
      ...row,
      deliveryItems: (() => { try { return JSON.parse(row.deliveryItems ?? "[]"); } catch { return []; } })(),
      verdict: row.verdict ? (() => { try { return JSON.parse(row.verdict); } catch { return null; } })() : null,
    }));

    return result;
  },
});
