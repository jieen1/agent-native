/**
 * @deprecated V1 orchestrator — superseded by v2 `run-start` (actions/run-start.ts)
 * combined with `v3-workflow` action `workflow.run`. This file is retained for
 * backward compatibility only.
 */
import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";
import { parseSteps, topoSortSteps } from "../shared/types.js";

// Seeds the run: validates the DAG, (re)creates pending step_runs in
// dependency order, flips the task to `running`, and returns an instruction
// the UI hands to the agent chat (delegate-to-agent). The actual multi-agent
// execution is performed by the orchestrator agent following the
// `orchestrating` skill — UIs never call an LLM directly.
export default defineAction({
  description:
    "Prepare a task run: build step runs from its workflow DAG and mark it running. Returns an instruction to hand to the orchestrator agent.",
  schema: z.object({
    taskId: z.string(),
  }),
  run: async (args) => {
    const access = await resolveAccess("task", args.taskId);
    if (!access) throw new Error(`Task ${args.taskId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    const task = access.resource as Record<string, unknown>;
    if (!task.workflowId) {
      throw new Error("Task has no workflow attached. Set one first.");
    }

    const db = getDb();
    const wfRows = await db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, String(task.workflowId)))
      .limit(1);
    const wf = wfRows[0];
    if (!wf) throw new Error("Attached workflow not found");

    const steps = topoSortSteps(parseSteps(wf.steps));
    if (steps.length === 0) throw new Error("Workflow has no steps");

    const now = nowIso();
    // Reset prior runs so re-running is clean.
    await db.delete(schema.stepRuns).where(eq(schema.stepRuns.taskId, args.taskId));
    let ordering = 0;
    for (const step of steps) {
      await db.insert(schema.stepRuns).values({
        id: newId("sr"),
        taskId: args.taskId,
        stepKey: step.key,
        title: step.title,
        assignee: step.assignee,
        engine: step.engine ?? null,
        model: step.model ?? null,
        status: "pending",
        output: null,
        error: null,
        agentRunId: null,
        ordering: ordering++,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    await db
      .update(schema.tasks)
      .set({ status: "running", result: null, updatedAt: now })
      .where(eq(schema.tasks.id, args.taskId));

    const instruction =
      `Execute orchestrator task ${args.taskId} ("${String(task.title)}") against workflow "${wf.name}". ` +
      `Follow the "orchestrating" skill: call get-task to read the ${steps.length} step runs in order, ` +
      `run each step's sub-agent with its assignee/engine/model, report progress with upsert-step-run, ` +
      `then deliver the final result with update-task. Stop immediately if the task status becomes cancelled.`;

    return { ok: true, taskId: args.taskId, stepCount: steps.length, instruction };
  },
});
