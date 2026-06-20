import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { resolveHumanGate } from "../server/engine/control.js";

// resolve-human-gate (DESIGN §3.1/§11): resolve a node parked at
// awaiting-approval. approve → mark done, release downstream; reject → done with
// a reject marker and its out-edge branch downstream set to skipped. The gate
// state lives in node_runs, NOT the chat transcript.
export default defineAction({
  description:
    "Resolve a human gate parked at awaiting-approval. approve releases downstream; reject marks it done and skips its out-edge branch downstream.",
  schema: z.object({
    runId: z.string(),
    nodeRunId: z.string(),
    decision: z.enum(["approve", "reject"]),
    input: z.unknown().optional(),
    echoDelayMs: z.coerce.number().int().min(0).optional(),
  }),
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    const outcome = await resolveHumanGate(
      args.runId,
      args.nodeRunId,
      args.decision,
      args.input,
      { echoDelayMs: args.echoDelayMs },
    );
    return {
      runId: args.runId,
      nodeRunId: args.nodeRunId,
      decision: args.decision,
      status: outcome.status,
      awaitingApproval: outcome.awaitingApproval ?? false,
    };
  },
});
