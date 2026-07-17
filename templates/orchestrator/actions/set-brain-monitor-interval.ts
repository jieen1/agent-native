// set-brain-monitor-interval — S9 Brain console "监控节奏" card's inline edit
// (04 §6). Directly persists brain_threads.monitor_interval_sec without
// requiring a full brain-send turn.

import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { setMonitorIntervalSec } from "../server/brain/brain-monitor.js";
import { resolveOwnerEmail } from "../server/db/index.js";

export default defineAction({
  description:
    "Set a brain thread's periodic drift-check interval in seconds " +
    "(brain_threads.monitor_interval_sec). 0 disables the timer (event-only " +
    "wakes). Owner-scoped.",
  schema: z.object({
    threadId: z.string().min(1),
    monitorIntervalSec: z.number().int().min(0).max(86_400),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = resolveOwnerEmail();
    await setMonitorIntervalSec(
      args.threadId,
      ownerEmail,
      args.monitorIntervalSec,
    );
    return {
      threadId: args.threadId,
      monitorIntervalSec: args.monitorIntervalSec,
    };
  },
});
