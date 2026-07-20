import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { getBrainMonitorDefaultIntervalSeconds } from "../server/orchestration-defaults.js";

export default defineAction({
  description:
    "Get the configured default periodic drift-check interval (seconds) " +
    "for brain threads that leave monitor_interval_sec unset — how often " +
    "the brain wakes to poll a run's progress when no event fired.",
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    const seconds = await getBrainMonitorDefaultIntervalSeconds();
    return { seconds };
  },
});
