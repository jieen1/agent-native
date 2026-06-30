// get-brain-concurrency (LEVEL-1). Read the current brain-task concurrency
// degree — how many orchestrator brain tasks run at once. Read-only; the
// admission gate + durable driver use the same value.

import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { getBrainConcurrency } from "../server/queue/brain-concurrency.js";

export default defineAction({
  description:
    "Return the current orchestrator BRAIN-task concurrency degree (how many brain " +
    "tasks run at once). Read-only.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const brainConcurrency = await getBrainConcurrency();
    return { brainConcurrency };
  },
});
