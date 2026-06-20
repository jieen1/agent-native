import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { cancelRun } from "../server/engine/control.js";

// run-cancel (DESIGN §4.3): cooperative abort. No new nodes scheduled; running
// stop at the next boundary; pending → skipped; run.status = cancelled.
export default defineAction({
  description:
    "Cancel a workflow run: no new nodes scheduled, pending/running nodes set to skipped, run.status=cancelled.",
  schema: z.object({ runId: z.string() }),
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    const result = await cancelRun(args.runId);
    return { runId: args.runId, ...result };
  },
});
