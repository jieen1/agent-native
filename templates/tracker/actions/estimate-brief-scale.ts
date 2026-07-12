import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { estimateScale } from "../server/lib/scale-estimate.js";

// F5 任务拆分阈值(规划前置契约) — docs/sdlc-impl-f5-f10.md §1A /
// docs/sdlc-product-design/02-workflows.md §3.10.
//
// Estimates a work item's implementation scale from its description text
// (the "brief") and persists the result to `scale_estimate` (v25 column).
// Idempotent (T-F5-02): estimateScale() is a pure function of the
// description text, so re-calling with an unchanged description always
// yields the same {files, crossLifecycle, verdict, signals} — only the `at`
// timestamp advances. dispatch-to-orchestrator.ts consumes the persisted
// column (or computes on the fly if absent) as its pre-dispatch gate.
export default defineAction({
  description:
    "Estimate a work item's implementation scale (file-count + cross-lifecycle " +
    "signal) from its description/brief text, and persist the result to " +
    "scale_estimate. Call before dispatching a large/ambiguous brief — if the " +
    "verdict is split-required, use split-work-item instead of dispatching.",
  schema: z.object({
    workItemId: z
      .string()
      .min(1)
      .describe("Work item whose description to estimate"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const item = (
      await db
        .select()
        .from(schema.workItems)
        .where(
          and(
            eq(schema.workItems.id, args.workItemId),
            ownerScope(schema.workItems),
          ),
        )
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found or not accessible");

    const result = estimateScale(item.description ?? "");
    const at = new Date().toISOString();
    const scaleEstimate = { ...result, at };

    // Deliberately does NOT bump updatedAt — this is a derived/cache field,
    // not a user edit, and bumping it would reshuffle updatedAt-ordered lists
    // on every re-estimate.
    await db
      .update(schema.workItems)
      .set({ scaleEstimate: JSON.stringify(scaleEstimate) })
      .where(eq(schema.workItems.id, item.id));

    return {
      workItemId: item.id,
      files: result.files,
      crossLifecycle: result.crossLifecycle,
      signals: result.signals,
      verdict: result.verdict,
      at,
    };
  },
});
