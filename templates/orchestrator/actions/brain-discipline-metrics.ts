// brain-discipline-metrics — S9 Brain console "纪律指标" card (04 §6). The
// workflowRun call count is computed CLIENT-SIDE from the already-loaded
// transcript (brain-thread's full event history); this action covers the two
// counters the transcript can't answer — see server/brain/discipline-metrics.ts.

import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { getDisciplineMetrics } from "../server/brain/discipline-metrics.js";
import { resolveOwnerEmail } from "../server/db/index.js";

export default defineAction({
  description:
    "Return this brain thread's discipline metrics: deniedFileEdits (this " +
    "thread's tool.denied count — the direct-write guardrail firing) and " +
    "vllmTokensToday (today's total vLLM worker token usage, global, " +
    "excluding usage-suspect rows). Backs the S9 Brain console's '纪律指标' " +
    "card ('brain 必须经 DAG 干活' evidence gauge).",
  schema: z.object({
    threadId: z.string().min(1),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const ownerEmail = resolveOwnerEmail();
    return getDisciplineMetrics(args.threadId, ownerEmail);
  },
});
