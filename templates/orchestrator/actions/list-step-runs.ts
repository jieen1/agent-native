import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description: "List a task's step runs in execution order (monitor progress).",
  schema: z.object({ taskId: z.string() }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const access = await resolveAccess("task", args.taskId);
    if (!access) throw new Error(`Task ${args.taskId} not found`);
    const db = getDb();
    return db
      .select()
      .from(schema.stepRuns)
      .where(eq(schema.stepRuns.taskId, args.taskId))
      .orderBy(asc(schema.stepRuns.ordering));
  },
});
