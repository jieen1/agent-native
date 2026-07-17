import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { backfillWorkItemRun } from "../server/lib/work-item-runs.js";
import { assertWritebackCaller } from "../server/lib/writeback-actor.js";

// F9 — 回写通道专用窄 action #2: runs 行回填(依赖 F8 交付物).
//
// 设计权威: docs/sdlc-impl-f5-f10.md §5A + 02-workflows.md §8 守卫表的"回链更新"
// 行("orchestrator_run_id / branch 为迁移必填载荷; 重派=新迁移=同步更新回链")。
//
// 纯粹是 `server/lib/work-item-runs.ts` 的 `backfillWorkItemRun`(F8 交付物,
// 已单测覆盖 T-F8-04/T-F8-07)套一层调用身份门 + 薄薄一层活动流记录。幂等语义
// 完全继承自 backfillWorkItemRun 本身: UNIQUE(work_item_id, run_id) 让同一
// runId 的重复回写第二次起是 no-op(T-F8-04), 陈旧/已被取代的 runId(没有对应
// 的"当前活跃(superseded=0 且 run_id 为空)"行可挂)回写为零写入。
export default defineAction({
  description:
    "回写通道专用窄 action(仅回写身份可调用): 把 run 终于确定的 runId/branch " +
    "回填到该工作项当前活跃的派发行(tracker_work_item_runs, F8 表)。幂等 —— " +
    "同一 runId 重复回填 no-op, 陈旧 runId 零写入。",
  schema: z.object({
    workItemId: z.string().min(1),
    runId: z.string().min(1).describe("The bound DAG/workflow run id"),
    branch: z.string().optional().describe("The delivery branch, once known"),
    // R4a.3 L2 (docs/sdlc-product-design/r4-workflow-families-planning-
    // skills.md §4.4 second bullet) — optional "brain deviated from the L1
    // suggestion" receipt. Leave-a-trace only: present only when the
    // orchestrator detected the run's actual template differs from
    // `tags.suggestedTemplate` (or the brain explicitly logged a
    // deviationReason anyway). Written as its own activity so the work
    // item's activity stream can render "brain 改用 X: reason".
    templateDeviation: z
      .object({
        chosen: z.string(),
        suggested: z.string().optional(),
        deviationReason: z.string().optional(),
      })
      .optional(),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    assertWritebackCaller({
      caller: ctx?.caller,
      userEmail: getRequestUserEmail(),
    });

    const db = getDb();
    const item = (
      await db
        .select({
          id: schema.workItems.id,
          ownerEmail: schema.workItems.ownerEmail,
          orgId: schema.workItems.orgId,
        })
        .from(schema.workItems)
        .where(eq(schema.workItems.id, args.workItemId))
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found");

    const { updated } = await backfillWorkItemRun(db, {
      workItemId: args.workItemId,
      runId: args.runId,
      branch: args.branch,
      ownerEmail: item.ownerEmail,
      orgId: item.orgId ?? null,
    });

    if (updated) {
      const now = new Date().toISOString();
      await db.insert(schema.activities).values({
        id: `act_wbrun_${item.id.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
        workItemId: item.id,
        actorKind: "agent",
        actorName: "回写通道",
        eventType: "writeback.run-meta",
        payload: JSON.stringify({
          runId: args.runId,
          branch: args.branch ?? null,
        }),
        createdAt: now,
        ownerEmail: item.ownerEmail,
        orgId: item.orgId ?? null,
        visibility: "private",
      });
    }

    // R4a.3 L2 — leave-a-trace only (§4.4 second bullet): a separate activity
    // row so the work item's activity stream can render "brain 改用 X 而非建议
    // 的 Y：理由". Written independent of `updated` (a stale/superseded runId
    // still carries a real, worth-recording deviation).
    if (args.templateDeviation) {
      const now = new Date().toISOString();
      await db.insert(schema.activities).values({
        id: `act_wbdev_${item.id.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
        workItemId: item.id,
        actorKind: "agent",
        actorName: "回写通道",
        eventType: "workflow.template-deviation",
        payload: JSON.stringify({
          runId: args.runId,
          chosen: args.templateDeviation.chosen,
          suggested: args.templateDeviation.suggested ?? null,
          deviationReason: args.templateDeviation.deviationReason ?? null,
        }),
        createdAt: now,
        ownerEmail: item.ownerEmail,
        orgId: item.orgId ?? null,
        visibility: "private",
      });
    }

    return { workItemId: args.workItemId, runId: args.runId, updated };
  },
});
