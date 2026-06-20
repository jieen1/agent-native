import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { nowIso } from "./_util.js";
import type { ExecState } from "../server/queue/exec-state.js";

// dequeue-work-item (DESIGN §6.4). Pull a queued item back out of the queue
// (queued → idle) before a worker claims it. Like enqueue, this touches ONLY the
// automation overlay (exec_state) and never business status (§6.2a). A claimed/
// running item cannot be dequeued (use run-cancel for an active run); a non-
// queued item is a no-op.
export default defineAction({
  description:
    "Remove a work item from the queue (exec_state queued → idle) before a worker claims it. Does NOT change business status. To stop an already-running item use run-cancel.",
  schema: z.object({ id: z.string().describe("Work item id") }),
  run: async (args) => {
    const access = await resolveAccess("work_item", args.id);
    if (!access) throw new Error(`Work item ${args.id} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    const item = access.resource as { id: string; execState: string };
    const from = item.execState as ExecState;

    if (from !== "queued") {
      return { id: args.id, execState: from, changed: false };
    }

    const db = getDb();
    // Guarded queued → idle: only fires while still queued, so a worker that
    // atomically claims it in the same instant wins (single-flight respected).
    await db
      .update(schema.workItems)
      .set({
        execState: "idle",
        claimedBy: null,
        claimedAt: null,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(schema.workItems.id, args.id),
          eq(schema.workItems.execState, "queued"),
        ),
      );

    return { id: args.id, execState: "idle" as const, changed: true };
  },
});
