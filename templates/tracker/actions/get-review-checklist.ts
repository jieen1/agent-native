import { defineAction } from "@agent-native/core";
import {
  getRequestOrgId,
  getRequestUserEmail,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { computeChecklistState } from "../server/lib/review-checklist.js";

export default defineAction({
  description:
    "S5 评审卡消费:按工作项 nature 装配核对清单(机器项:新表/新列↔迁移对账、" +
    "迁移冒烟证据在场;人工项:事务包裹、ownerScope 贯穿),叠加已持久化的确认" +
    "状态(锚定 tracker_sprint_artifacts[review:<workItemId>] + " +
    "tracker_artifact_reviews,reviewKey 命名空间 checklist:<key>)。带 diff " +
    "时按该 diff 增量对账(评审时用,被审代码是未合并分支);不带 diff 时对当前 " +
    "运行实例自身的 schema/迁移做全量健康检查。同步写回机器项的最新判定结果" +
    "(供 transition-work-item 的 done 守卫钩读取),因此不是纯只读 action。",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item id"),
    diff: z
      .string()
      .optional()
      .describe(
        "Unified diff for this item's pending review — omit for a full live-repo audit.",
      ),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
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

    let nature: string[] = [];
    try {
      nature = JSON.parse(item.nature ?? "[]");
    } catch {
      nature = [];
    }

    const state = await computeChecklistState(
      db,
      ownerEmail,
      orgId,
      { id: item.id, sprintId: item.sprintId, nature },
      args.diff,
    );

    return {
      workItemId: item.id,
      artifactId: state.anchor?.artifactId ?? null,
      version: state.anchor?.version ?? null,
      complete: state.complete,
      items: state.items,
    };
  },
});
