import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { nowIso } from "./_util.js";
import { canTransitionExec, type ExecState } from "../server/queue/exec-state.js";

// assign-work-item (DESIGN §6.4) = the enqueue shorthand: assigning a work item
// to the orchestrator IS enqueuing it. Identical semantics to enqueue-work-item
// (idle/done/failed → queued, optional workflowId/priority, business status
// untouched); kept as a separate verb because "assign to the orchestrator" is
// the user-facing phrasing the board uses. The shared transition logic lives in
// the exec-state machine so both verbs validate against one source of truth.
export default defineAction({
  description:
    "Assign a work item to the orchestrator (enqueue shorthand): exec_state idle/done/failed → queued, optionally setting workflowId/priority. Does NOT change business status. Equivalent to enqueue-work-item.",
  schema: z.object({
    id: z.string().describe("Work item id"),
    priority: z.coerce.number().int().optional(),
    workflowId: z.string().optional(),
  }),
  run: async (args) => {
    const access = await resolveAccess("work_item", args.id);
    if (!access) throw new Error(`Work item ${args.id} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    const item = access.resource as { id: string; execState: string };
    const from = item.execState as ExecState;

    if (from === "queued" || from === "claimed" || from === "running") {
      return { id: args.id, execState: from, changed: false };
    }
    if (!canTransitionExec(from, "queued")) {
      throw new Error(
        `cannot assign from exec_state '${from}' (expected idle/done/failed/paused)`,
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

    await db
      .update(schema.workItems)
      .set(patch)
      .where(
        and(eq(schema.workItems.id, args.id), eq(schema.workItems.execState, from)),
      );

    return { id: args.id, execState: "queued" as const, changed: true };
  },
});
