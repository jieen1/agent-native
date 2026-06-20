import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { resumeRun } from "../server/engine/control.js";

// run-resume (DESIGN §4.3/§1.7): the two-pass resume. A done-and-clean NodeRun
// replays from its journaled output artifact at ZERO executor invocations; only
// the dirty tail (failed/pending + their downstream, plus any invalidated
// fanout subtree) re-runs live.
export default defineAction({
  description:
    "Resume a paused/partially-completed run from its journal. Replays done nodes (0 executor calls) and re-runs only the dirty tail.",
  schema: z.object({
    runId: z.string(),
    echoDelayMs: z.coerce.number().int().min(0).optional(),
    maxConcurrentModelCalls: z.coerce.number().int().positive().optional(),
  }),
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    const outcome = await resumeRun(args.runId, {
      echoDelayMs: args.echoDelayMs,
      caps: args.maxConcurrentModelCalls
        ? { maxConcurrentModelCalls: args.maxConcurrentModelCalls }
        : undefined,
    });
    return {
      runId: args.runId,
      status: outcome.status,
      tokensSpent: outcome.tokensSpent,
      nodeRunCount: outcome.nodeRuns.length,
      awaitingApproval: outcome.awaitingApproval ?? false,
    };
  },
});
