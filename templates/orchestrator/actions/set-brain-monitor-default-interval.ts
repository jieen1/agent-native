import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { setBrainMonitorDefaultIntervalSeconds } from "../server/orchestration-defaults.js";

export default defineAction({
  description:
    "Set the configured default periodic drift-check interval (seconds) " +
    "for brain threads that leave monitor_interval_sec unset. Raising this " +
    "cuts brain (Claude) token spend on long-running tasks that mostly just " +
    "need a periodic on-track check, not a tight poll loop. 0 disables the " +
    "periodic timer entirely (event-only wakes). Individual threads can " +
    "still override via set-brain-monitor-interval.",
  schema: z.object({
    seconds: z
      .number()
      .int()
      .min(0)
      .describe("New default interval in seconds, e.g. 600. 0 = event-only"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const seconds = await setBrainMonitorDefaultIntervalSeconds(args.seconds);
    return { seconds };
  },
});
