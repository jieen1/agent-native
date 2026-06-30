/**
 * @deprecated Use `get-work-item` (actions/get-work-item.ts) instead.
 * This V1 action is retained for backward compatibility only.
 */
import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { parseSteps, type Task, type Workflow } from "../shared/types.js";

// Returns the task, its workflow (if any), and all step runs — everything the
// task detail view and the orchestrator agent need in one round trip.
export default defineAction({
  description:
    "Get a single task with its workflow definition and step-run progress.",
  schema: z.object({ id: z.string() }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const access = await resolveAccess("task", args.id);
    if (!access) throw new Error(`Task ${args.id} not found`);
    const row = access.resource as Record<string, unknown>;
    const db = getDb();

    let workflow: Workflow | null = null;
    if (row.workflowId) {
      const wfRows = await db
        .select()
        .from(schema.workflows)
        .where(eq(schema.workflows.id, String(row.workflowId)))
        .limit(1);
      const wf = wfRows[0];
      if (wf) {
        workflow = {
          id: wf.id,
          name: wf.name,
          description: wf.description,
          steps: parseSteps(wf.steps),
          createdAt: wf.createdAt,
          updatedAt: wf.updatedAt,
        };
      }
    }

    const stepRuns = await db
      .select()
      .from(schema.stepRuns)
      .where(eq(schema.stepRuns.taskId, args.id))
      .orderBy(asc(schema.stepRuns.ordering));

    const task: Task = {
      id: String(row.id),
      title: String(row.title),
      description: String(row.description ?? ""),
      status: row.status as Task["status"],
      workflowId: (row.workflowId as string | null) ?? null,
      result: (row.result as string | null) ?? null,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };

    return { task, workflow, stepRuns, role: access.role };
  },
});
