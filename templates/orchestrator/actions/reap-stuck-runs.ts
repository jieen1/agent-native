import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { reapStrandedNodeRuns } from "../server/engine/store.js";
import { REAP_THRESHOLD_MS } from "../server/engine/reap.js";

// reap-stuck-runs (DESIGN §6.4/§13): return stranded `running` NodeRuns whose
// last_heartbeat is older than the explicit reapThreshold to failed, so a
// crashed/redeployed scheduler does not leave a row wedged at running forever.
// A FRESH-heartbeat running row is NOT reaped. The durable tick (server-plugin)
// calls this on a loop; it is also exposed as an action for manual/headless use.
export default defineAction({
  description:
    "Reap stranded running NodeRuns (last_heartbeat older than the reap threshold) to failed. A fresh-heartbeat running row is not reaped.",
  schema: z.object({
    thresholdMs: z.coerce.number().int().positive().optional(),
  }),
  run: async (args) => {
    const thresholdMs = args.thresholdMs ?? REAP_THRESHOLD_MS;
    const cutoffIso = new Date(Date.now() - thresholdMs).toISOString();
    const reaped = await reapStrandedNodeRuns(getDb(), cutoffIso);
    return { reapedCount: reaped.length, reaped, thresholdMs, cutoffIso };
  },
});
