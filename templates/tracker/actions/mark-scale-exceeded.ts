import { defineAction } from "@agent-native/core";
import {
  getRequestOrgId,
  getRequestUserEmail,
} from "@agent-native/core/server/request-context";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { markScaleExceeded } from "../server/lib/scale-runtime-signal.js";

// F5 运行期规模定性 (docs/sdlc-impl-f5-f10.md §1A, server/lib/scale-runtime-signal.ts
// row). Thin actions/ wrapper — the framework routes `pnpm action`/HTTP/agent
// calls by filename (actions/<name>.ts), so the actual read-modify-write
// logic lives in server/lib/scale-runtime-signal.ts and this file only wires
// it to the action surface (see that file's docblock for the full rationale).
//
// F9 (orchestrator writeback of spawn budget-exhaustion events) is not
// landed and — per the R3 completeness-gap note in §1A — no producer for a
// "budget exhausted" event exists anywhere yet (F2/F7). Until that lands,
// this is the ONLY path that flips scale_estimate.verdict to
// 'split-required' at runtime: a human reviewer who watched vLLM exhaust its
// output budget on this item ≥2 times calls this action directly.
export default defineAction({
  description:
    "Mark a work item's scale estimate as runtime-exceeded after the dev " +
    "engine has exhausted its output budget on it repeatedly (≥2 times) — " +
    "the manual-trigger path until the orchestrator's automatic budget-" +
    "exhaustion event exists. Flips scale_estimate.verdict to " +
    "'split-required' and logs a scale.exceeded-at-runtime activity.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item to mark"),
    exhaustionCount: z
      .number()
      .int()
      .min(1)
      .describe(
        "How many times the dev engine exhausted its output budget on this item",
      ),
    reason: z
      .string()
      .optional()
      .describe("Optional human note (e.g. run/thread reference)"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    const result = await markScaleExceeded(db, schema, {
      workItemId: args.workItemId,
      exhaustionCount: args.exhaustionCount,
      ownerEmail,
      orgId,
      reason: args.reason,
    });

    return {
      workItemId: args.workItemId,
      marked: result.marked,
      scaleEstimate: result.scaleEstimate,
    };
  },
});
