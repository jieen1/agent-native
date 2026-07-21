import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

const STAGE_ORDER = ["待办", "分析", "设计", "实施", "测试", "验收", "交付"];

export default defineAction({
  description: "List all artifacts for a work item, grouped by stage.",
  schema: z.object({ workItemId: z.string().min(1) }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const rows = await db
      .select()
      .from(schema.artifacts)
      .where(
        and(
          eq(schema.artifacts.workItemId, args.workItemId),
          ownerScope(schema.artifacts),
        ),
      )
      .orderBy(asc(schema.artifacts.createdAt));

    const byStage: Record<string, typeof rows> = {};
    for (const r of rows) {
      if (!byStage[r.stageName]) byStage[r.stageName] = [];
      byStage[r.stageName].push(r);
    }

    // Return in stage order
    const ordered: Record<string, typeof rows> = {};
    for (const s of STAGE_ORDER) {
      if (byStage[s]) ordered[s] = byStage[s];
    }
    // Append any unexpected stage names
    for (const [k, v] of Object.entries(byStage)) {
      if (!ordered[k]) ordered[k] = v;
    }

    return { byStage: ordered };
  },
});
