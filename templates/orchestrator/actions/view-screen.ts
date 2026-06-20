import { defineAction } from "@agent-native/core/action";
import { readAppState } from "@agent-native/core/application-state";
import { resolveAccess } from "@agent-native/core/sharing";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// First tool to call: tells the agent what the user is looking at, and if a
// task is open, summarizes its status and step progress so the orchestrator has
// the live context it needs without extra round trips.
export default defineAction({
  description:
    "See what the user is looking at. Returns navigation and, when a task is open, its status and step-run progress. Call this first.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = (await readAppState("navigation")) as
      | { view?: string; id?: string }
      | null;
    const screen: Record<string, unknown> = {};
    if (navigation) screen.navigation = navigation;

    const taskId = navigation?.view === "task" ? navigation.id : undefined;
    if (taskId) {
      const access = await resolveAccess("task", taskId).catch(() => null);
      if (access) {
        const t = access.resource as Record<string, unknown>;
        const db = getDb();
        const runs = await db
          .select({
            stepKey: schema.stepRuns.stepKey,
            title: schema.stepRuns.title,
            status: schema.stepRuns.status,
            assignee: schema.stepRuns.assignee,
            model: schema.stepRuns.model,
          })
          .from(schema.stepRuns)
          .where(eq(schema.stepRuns.taskId, taskId))
          .orderBy(asc(schema.stepRuns.ordering));
        screen.task = {
          id: t.id,
          title: t.title,
          status: t.status,
          workflowId: t.workflowId,
          steps: runs,
        };
      }
    }

    if (Object.keys(screen).length === 0) {
      return "No application state found. Is the app running?";
    }
    return screen;
  },
});
