import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { putSetting } from "@agent-native/core/settings";
import { z } from "zod";

import {
  SCHEDULER_SETTING_KEY,
  type SchedulerState,
} from "../server/lib/scheduler-gate.js";

// Real, persisted pause — not a useState toggle. Once paused,
// dispatch-to-orchestrator (single-item dispatch, including the queue page's
// "立即派发") throws before ever calling the orchestrator, so the pause has a
// real effect on the system, not just a queue-page banner. Survives reload
// and container restart (settings store, not client state).
export default defineAction({
  description:
    "Pause the tracker's dispatch scheduler. While paused, new dispatch " +
    "attempts (single-item dispatch, including 'immediate dispatch' from the " +
    "queue page) are rejected with a scheduler-paused error. Persisted — " +
    "survives reload/restart. Does not affect items already running.",
  schema: z.object({}),
  http: { method: "POST" },
  run: async () => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const now = new Date().toISOString();
    const next: SchedulerState = {
      paused: true,
      pausedAt: now,
      pausedBy: ownerEmail,
      resumedAt: null,
      resumedBy: null,
    };
    await putSetting(
      SCHEDULER_SETTING_KEY,
      next as unknown as Record<string, unknown>,
    );
    return next;
  },
});
