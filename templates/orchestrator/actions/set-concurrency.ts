import { defineAction } from "@agent-native/core";
import { z } from "zod";
import {
  setConcurrencyDegree,
  MAX_CONCURRENCY_DEGREE,
} from "../server/queue/concurrency.js";

// set-concurrency (DESIGN §6.4). Set the worker-pool width (concurrencyDegree) —
// how many work items the orchestrator runs at once. Persisted as a setting so
// it is tuned without code (Settings → Runtime); the durable driver reads it on
// each tick, so the pool width changes on the next drain. Clamped to [1, MAX].
export default defineAction({
  description:
    "Set the orchestrator's concurrency degree (worker-pool width — how many work items run at once). Persisted; the worker pool reads it on the next drain.",
  schema: z.object({
    degree: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_CONCURRENCY_DEGREE)
      .describe(`Worker-pool width, 1..${MAX_CONCURRENCY_DEGREE}`),
  }),
  run: async (args) => {
    const stored = await setConcurrencyDegree(args.degree);
    return { concurrencyDegree: stored };
  },
});
