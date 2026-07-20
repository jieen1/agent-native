// brain-usage — the per-session CONTEXT panel for the /brain page.
//
// CONTEXT ONLY. This action is intentionally LOCAL + DB-only: it returns the
// brain thread's current model and context fill (used / window / %), all read
// straight from `brain_threads` (captured from the stream-json child at turn
// end — never an Anthropic call). The brain page may poll it cheaply.
//
// The account-level subscription usage (5-hour / weekly limits + plan tier from
// the Anthropic oauth/usage + oauth/profile endpoints) is NO LONGER fetched
// here. It moved to the single GLOBAL `account-usage` action + sidebar indicator
// (slow, SQL-cached, on-demand) so a per-session view never hits Anthropic and
// the brain page's poll can no longer drive a continuous /oauth/usage hit. This
// action makes ZERO outbound network calls and never reads the managed token.

import { defineAction } from "@agent-native/core";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";

import {
  getBrainModel,
  getRawBrainModelSetting,
  parseRuntimeModelSelector,
} from "../server/brain/brain-model.js";
import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";

/**
 * Derive the context window (tokens) from a model id by FAMILY when the thread
 * hasn't yet captured a real `context_window` (it is only persisted at turn-END
 * from the result event's modelUsage, so a thread still in its first/current
 * turn has NULL). The `[1m]` suffix is captured INCONSISTENTLY (the same model
 * shows as `claude-opus-4-8[1m]` on one thread and `claude-opus-4-8` on
 * another), so we match the model family, not the suffix: opus 4.8 / 4.7 / 4.6
 * (and anything carrying `[1m]`) are 1M-context; opus 4.5, sonnet 4.6, haiku 4.5
 * are the standard 200k. Default 200k. The captured value is always preferred
 * over this derivation when present. Shared with brain-session.ts's early set.
 */
export function deriveContextWindow(model: string | null): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (/\[1m\]/.test(m)) return 1_000_000;
  if (/opus-4-8|opus-4-7|opus-4-6/.test(m)) return 1_000_000;
  // sonnet-5: 200k default window (Anthropic model spec); sonnet-5[1m] → 1M via the [1m] check above.
  if (/opus-4-5|sonnet-4-6|haiku-4-5|sonnet-5/.test(m)) return 200_000;
  return 200_000;
}

export default defineAction({
  description:
    "Per-session CONTEXT for the orchestrator brain: the brain thread's current " +
    "model and context fill (used / window / %). All values are read from the " +
    "local brain_threads row (captured from the stream child) — this action " +
    "makes NO Anthropic/network call and never reads any token. Account-level " +
    "subscription usage lives in the separate `account-usage` action. Pass a " +
    "threadId to read that thread; otherwise the owner's latest thread is used.",
  schema: z.object({
    /** Read this thread's model/context; omit → the owner's latest thread. */
    threadId: z.string().optional(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    // Fail-closed owner scope — even an explicit threadId is constrained to the
    // resolved owner so no request can read another owner's thread context.
    const ownerEmail = resolveOwnerEmail();
    const db = getV3Db();

    // ── model + context from the brain thread (DB ONLY) ──────────────────────
    let threadRow:
      | {
          id: string;
          model: string | null;
          contextWindow: number | null;
          contextUsed: number | null;
        }
      | undefined;
    const select = {
      id: v3Schema.brainThreads.id,
      model: v3Schema.brainThreads.model,
      contextWindow: v3Schema.brainThreads.contextWindow,
      contextUsed: v3Schema.brainThreads.contextUsed,
    };
    if (args.threadId) {
      const rows = await db
        .select(select)
        .from(v3Schema.brainThreads)
        .where(
          and(
            eq(v3Schema.brainThreads.id, args.threadId),
            eq(v3Schema.brainThreads.ownerEmail, ownerEmail),
          ),
        )
        .limit(1);
      threadRow = rows[0];
    } else {
      // Latest thread that actually has a captured model (so a brand-new empty
      // thread doesn't blank the panel).
      const rows = await db
        .select(select)
        .from(v3Schema.brainThreads)
        .where(eq(v3Schema.brainThreads.ownerEmail, ownerEmail))
        .orderBy(desc(v3Schema.brainThreads.updatedAt))
        .limit(20);
      threadRow = rows.find((r) => r.model) ?? rows[0];
    }

    // The configured override (so the Select reflects a pending switch even
    // before the next turn re-captures the resolved init model). Unchanged —
    // still degrades a `runtime:<id>` override to DEFAULT_BRAIN_MODEL, same
    // as any other unrecognized value, so this field's meaning never changes.
    const configuredModel = await getBrainModel();
    // Additive: the RAW setting value, only when it is a `runtime:<id>`
    // selector — lets the UI show a saved runtime-override's real row name
    // instead of falling into the "unknown override" bucket (getBrainModel()
    // itself must stay untouched for every other caller).
    const rawModelSetting = await getRawBrainModelSetting();
    const runtimeOverrideId = parseRuntimeModelSelector(rawModelSetting);
    // The ACTUAL model the thread ran as (captured from the init `system` event),
    // independent of any override.
    const actualModel = threadRow?.model ?? null;
    const model = actualModel ?? configuredModel ?? null;
    const used = threadRow?.contextUsed ?? null;
    // Prefer the captured window; otherwise derive it from the model id so a
    // RUNNING thread (window not yet persisted) still shows a real fill %.
    const capturedWindow = threadRow?.contextWindow ?? null;
    const window = capturedWindow ?? deriveContextWindow(actualModel ?? model);
    const windowDerived = capturedWindow == null && window != null;
    const contextPct =
      window && used != null && window > 0
        ? Math.min(100, Math.round((used / window) * 1000) / 10)
        : null;

    return {
      model,
      actualModel,
      configuredModel,
      runtimeOverrideId,
      context: { used, window, pct: contextPct, windowDerived },
    };
  },
});
