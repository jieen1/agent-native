import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";

// The orchestrator agent calls this to report each step's progress as it walks
// the DAG: mark it running, then done/failed with the produced output. Keyed by
// (taskId, stepKey); creates the row if the agent adds an ad-hoc step.
export default defineAction({
  description:
    "Report progress for one workflow step run: set its status, output, error, model/engine, or sub-agent run id.",
  schema: z.object({
    taskId: z.string(),
    stepKey: z.string(),
    title: z.string().optional(),
    assignee: z.string().optional(),
    engine: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    status: z
      .enum(["pending", "running", "done", "failed", "skipped"])
      .optional(),
    output: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    agentRunId: z.string().nullable().optional(),
  }),
  run: async (args) => {
    const access = await resolveAccess("task", args.taskId);
    if (!access) throw new Error(`Task ${args.taskId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");

    const db = getDb();
    const now = nowIso();
    const existing = await db
      .select()
      .from(schema.stepRuns)
      .where(
        and(
          eq(schema.stepRuns.taskId, args.taskId),
          eq(schema.stepRuns.stepKey, args.stepKey),
        ),
      )
      .limit(1);

    const patch: Record<string, unknown> = { updatedAt: now };
    if (args.title !== undefined) patch.title = args.title;
    if (args.assignee !== undefined) patch.assignee = args.assignee;
    if (args.engine !== undefined) patch.engine = args.engine;
    if (args.model !== undefined) patch.model = args.model;
    if (args.output !== undefined) patch.output = args.output;
    if (args.error !== undefined) patch.error = args.error;
    if (args.agentRunId !== undefined) patch.agentRunId = args.agentRunId;
    if (args.status !== undefined) {
      patch.status = args.status;
      if (args.status === "running") patch.startedAt = now;
      if (["done", "failed", "skipped"].includes(args.status)) {
        patch.completedAt = now;
      }
    }

    if (existing[0]) {
      await db
        .update(schema.stepRuns)
        .set(patch)
        .where(eq(schema.stepRuns.id, existing[0].id));
      return { id: existing[0].id, ok: true };
    }

    // Ad-hoc step the agent introduced — append at the end.
    const countRows = await db
      .select({ id: schema.stepRuns.id })
      .from(schema.stepRuns)
      .where(eq(schema.stepRuns.taskId, args.taskId));
    const id = newId("sr");
    await db.insert(schema.stepRuns).values({
      id,
      taskId: args.taskId,
      stepKey: args.stepKey,
      title: args.title ?? args.stepKey,
      assignee: args.assignee ?? "local",
      engine: args.engine ?? null,
      model: args.model ?? null,
      status: args.status ?? "pending",
      output: args.output ?? null,
      error: args.error ?? null,
      agentRunId: args.agentRunId ?? null,
      ordering: countRows.length,
      startedAt: args.status === "running" ? now : null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    return { id, ok: true };
  },
});
