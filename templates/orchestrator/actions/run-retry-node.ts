import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { retryNode } from "../server/engine/control.js";

// run-retry-node (DESIGN §4.3): reset a failed node to re-run live. Its
// downstream divergent tail re-runs; upstream is reused from the journal (0
// upstream executor invokes).
export default defineAction({
  description:
    "Retry a failed NodeRun: reset it to ready and re-run live; its downstream re-runs, upstream is reused from journal (0 upstream executor calls).",
  schema: z.object({
    runId: z.string(),
    nodeRunId: z.string(),
    echoDelayMs: z.coerce.number().int().min(0).optional(),
  }),
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    const outcome = await retryNode(args.runId, args.nodeRunId, {
      echoDelayMs: args.echoDelayMs,
    });
    return {
      runId: args.runId,
      nodeRunId: args.nodeRunId,
      status: outcome.status,
      tokensSpent: outcome.tokensSpent,
    };
  },
});
