import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { pauseRun } from "../server/engine/control.js";

// run-pause (DESIGN §4.3): stop scheduling NEW nodes; let running settle. Sets
// the run to `paused` so a later run-resume picks the journal up.
export default defineAction({
  description:
    "Pause a workflow run: stop scheduling new nodes and let running nodes settle. Sets run.status=paused.",
  schema: z.object({ runId: z.string() }),
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    const result = await pauseRun(args.runId);
    return { runId: args.runId, ...result };
  },
});
