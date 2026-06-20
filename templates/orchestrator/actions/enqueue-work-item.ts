import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { nowIso } from "./_util.js";
import { canTransitionExec, type ExecState } from "../server/queue/exec-state.js";

// enqueue-work-item (DESIGN §6.4). Move a work item's AUTOMATION overlay from
// idle → queued so the worker pool picks it up, optionally setting its
// workflow_id (the template the run instantiates) and/or priority. This is the
// queue's job and is STRICTLY SEPARATE from business status (§6.2a): it sets
// ONLY exec_state / workflow_id / priority and NEVER writes status, environment,
// blocked, resolution, or severity. Re-enqueuing a done/failed item is allowed
// (a re-run = a new workflow_run); already-queued/claimed/running is a no-op.
export default defineAction({
  description:
    "Enqueue a work item for the orchestrator (exec_state idle/done/failed → queued). Optionally set its workflowId (the template to run) and priority. Does NOT change business status — that is transition-work-item's job. Returns the item's new exec_state.",
  schema: z.object({
    id: z.string().describe("Work item id"),
    priority: z.coerce
      .number()
      .int()
      .optional()
      .describe("Lower runs first; priority-ordered queue"),
    workflowId: z
      .string()
      .optional()
      .describe("Template id the run instantiates (sets work_item.workflow_id)"),
  }),
  run: async (args) => {
    const access = await resolveAccess("work_item", args.id);
    if (!access) throw new Error(`Work item ${args.id} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    const item = access.resource as { id: string; execState: string };
    const from = item.execState as ExecState;

    // Already in flight → idempotent no-op (don't disturb a running run).
    if (from === "queued" || from === "claimed" || from === "running") {
      return { id: args.id, execState: from, changed: false };
    }
    if (!canTransitionExec(from, "queued")) {
      throw new Error(
        `cannot enqueue from exec_state '${from}' (expected idle/done/failed/paused)`,
      );
    }

    const db = getDb();
    const now = nowIso();
    const patch: Record<string, unknown> = {
      execState: "queued",
      claimedBy: null,
      claimedAt: null,
      updatedAt: now,
    };
    if (args.workflowId !== undefined) patch.workflowId = args.workflowId;
    if (args.priority !== undefined) patch.priority = args.priority;

    // Guarded update: only flip if still in the expected source state, so a
    // concurrent claim can't be clobbered (single-flight respected at enqueue).
    await db
      .update(schema.workItems)
      .set(patch)
      .where(
        and(eq(schema.workItems.id, args.id), eq(schema.workItems.execState, from)),
      );

    return { id: args.id, execState: "queued" as const, changed: true };
  },
});
