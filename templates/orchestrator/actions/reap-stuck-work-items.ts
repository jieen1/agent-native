import { defineAction } from "@agent-native/core";
import { z } from "zod";
import {
  reapQueueOnce,
  WORK_ITEM_REAP_THRESHOLD_MS,
} from "../server/queue/reap.js";

// reap-stuck-work-items (DESIGN §6.4 D-3 / §13). Return stranded claimed/running
// work items (claimed_at older than the explicit reapThreshold) to queued so a
// crashed/redeployed worker's item is re-claimed rather than wedged. A FRESH
// claim is NOT reaped. The durable driver tick calls this internally; it is also
// exposed as an action for manual/headless use (and the queue reap acceptance).
export default defineAction({
  description:
    "Reap stranded claimed/running work items (claimed_at older than the reap threshold) back to queued so a dead worker's item is re-claimed. A fresh-claim item is not reaped.",
  schema: z.object({
    thresholdMs: z.coerce.number().int().positive().optional(),
  }),
  run: async (args) => {
    const thresholdMs = args.thresholdMs ?? WORK_ITEM_REAP_THRESHOLD_MS;
    const reaped = await reapQueueOnce(thresholdMs);
    return { reapedCount: reaped.length, reaped, thresholdMs };
  },
});
