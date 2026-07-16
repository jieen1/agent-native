import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { putSetting } from "@agent-native/core/settings";
import { z } from "zod";

import {
  SCHEDULER_SETTING_KEY,
  type SchedulerState,
} from "../server/lib/scheduler-gate.js";

export default defineAction({
  description:
    "Resume the tracker's dispatch scheduler after a pause-scheduler call. " +
    "New dispatch attempts are allowed again. Persisted — survives " +
    "reload/restart.",
  schema: z.object({}),
  http: { method: "POST" },
  run: async () => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const now = new Date().toISOString();
    const next: SchedulerState = {
      paused: false,
      pausedAt: null,
      pausedBy: null,
      resumedAt: now,
      resumedBy: ownerEmail,
    };
    await putSetting(
      SCHEDULER_SETTING_KEY,
      next as unknown as Record<string, unknown>,
    );
    return next;
  },
});
