import { defineAction } from "@agent-native/core";
import { accessFilter } from "@agent-native/core/sharing";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// List work items the caller can see (owner-scoped), optionally filtered by
// project / type / status category / exec state. The board reads this grouped
// by status; the queue view groups by exec_state.
export default defineAction({
  description:
    "List work items, newest first. Optional filters: projectId, type, statusCategory, execState.",
  schema: z.object({
    projectId: z.string().optional(),
    type: z.enum(["requirement", "bug", "prod-issue", "task"]).optional(),
    statusCategory: z
      .enum(["todo", "in-progress", "completed", "cancelled"])
      .optional(),
    execState: z
      .enum([
        "idle",
        "queued",
        "claimed",
        "running",
        "paused",
        "failed",
        "done",
      ])
      .optional(),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const db = getDb();
    const conds = [accessFilter(schema.workItems, schema.workItemShares)];
    if (args.projectId)
      conds.push(eq(schema.workItems.projectId, args.projectId));
    if (args.type) conds.push(eq(schema.workItems.type, args.type));
    if (args.statusCategory)
      conds.push(eq(schema.workItems.statusCategory, args.statusCategory));
    if (args.execState)
      conds.push(eq(schema.workItems.execState, args.execState));

    const rows = await db
      .select()
      .from(schema.workItems)
      .where(and(...conds))
      .orderBy(desc(schema.workItems.updatedAt));

    return rows.map((w) => ({
      id: w.id,
      projectId: w.projectId,
      type: w.type,
      title: w.title,
      priority: w.priority,
      assignee: w.assignee,
      status: w.status,
      statusCategory: w.statusCategory,
      environment: w.environment,
      severity: w.severity,
      blocked: w.blocked === 1,
      blockedReason: w.blockedReason,
      blockedBy: w.blockedBy,
      resolution: w.resolution,
      statusStale: w.statusStale === 1,
      execState: w.execState,
      workflowId: w.workflowId,
      workflowRunId: w.workflowRunId,
      deliverable: w.deliverable ? JSON.parse(w.deliverable) : null,
      updatedAt: w.updatedAt,
    }));
  },
});
