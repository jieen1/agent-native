import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { getQueueStatus } from "../server/queue/status.js";

// queue-status (DESIGN §6.4). The whole-queue snapshot the orchestrator brain
// reads to plan order/batching, and the UI shows as the capacity indicator:
// both concurrency ceilings (concurrencyDegree + maxConcurrentVMs/vmsInUse), the
// live execState counts (running/queued/claimed), and the durable driver's
// self-observation (schedulerAlive/lastTickAt/reapsFired) so a dead tick is
// visible rather than a silently-wedged queue.
export default defineAction({
  description:
    "Return the orchestrator queue snapshot: concurrencyDegree, running/queued/claimed counts, maxConcurrentVMs/vmsInUse, and scheduler health (schedulerAlive/lastTickAt/reapsFired).",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    return getQueueStatus();
  },
});
