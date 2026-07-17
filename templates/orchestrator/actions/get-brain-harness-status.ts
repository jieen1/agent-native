// get-brain-harness-status — S9 Brain console "能力降级" red card (04 §6/§7,
// SDLC-049). Read-only.

import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { getBrainHarnessStatus } from "../server/brain/harness-status.js";
import { resolveOwnerEmail } from "../server/db/index.js";

export default defineAction({
  description:
    "Return the orchestrator brain harness capability-degradation status: " +
    "whether ORCH_BRAIN_HARNESS is opted in, whether the acp:claude-code " +
    "harness is actually usable right now, the live degradedReason when " +
    "opted-in-but-broken, and the most recent capability.degraded event on " +
    "record (reason/threadId/ts) plus its all-time count. Backs the S9 " +
    "Brain console's red 'capability degraded' card — 04 §6/§7 SDLC-049 " +
    "'silent degradation is itself a defect'.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const ownerEmail = resolveOwnerEmail();
    return getBrainHarnessStatus(ownerEmail);
  },
});
