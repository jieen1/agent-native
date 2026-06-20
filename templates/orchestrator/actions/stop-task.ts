import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { nowIso } from "./_util.js";

// Control: cancel a running task. Flips the task to `cancelled` and skips any
// still-pending/running steps. The orchestrator agent is instructed to check
// task status between steps and halt when it sees `cancelled`.
export default defineAction({
  description: "Stop/cancel a running task and skip its remaining steps.",
  schema: z.object({ taskId: z.string() }),
  run: async (args) => {
    const access = await resolveAccess("task", args.taskId);
    if (!access) throw new Error(`Task ${args.taskId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");

    const db = getDb();
    const now = nowIso();
    await db
      .update(schema.tasks)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(schema.tasks.id, args.taskId));
    await db
      .update(schema.stepRuns)
      .set({ status: "skipped", completedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.stepRuns.taskId, args.taskId),
          inArray(schema.stepRuns.status, ["pending", "running"]),
        ),
      );
    return { taskId: args.taskId, ok: true };
  },
});
