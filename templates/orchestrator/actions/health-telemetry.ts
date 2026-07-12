// S10 health telemetry — folded action serving BOTH health-page cards that
// independently claimed this action name (F0 cross-branch reconciliation):
//
// 1) F7's "遥测可信卡" (telemetry-trust card, 04 §10): suspect-usage spawns,
//    alias-drift events, capability-degradation events, R9 conduction fixes,
//    and config-inconsistency events. Any non-zero count means the card
//    should render yellow (all zero = green). Suspect data must never be
//    silently folded into aggregated metrics elsewhere (degree/insights
//    pages) — this action is the readable proof that it is being tracked
//    instead. `conductionFixes` (F10's spawn->node reconciler transition)
//    and `configInconsistencyEvents` (the maxOutputTokens-clamp / env-
//    override point, owned by F0/F2's clamp code in packages/core) read
//    v3_events kinds whose PRODUCERS are not part of this change — both
//    report a real (currently-always-0) count plus a `*Pending: true` flag
//    rather than a false all-clear, so the UI can distinguish "confirmed
//    zero" from "nothing emits this yet".
//
// 2) F9's "调度器" (scheduler) card writeback counters (docs/sdlc-impl-f5-
//    f10.md §5B): "S10 健康页『调度器』卡加一行『回写:最近成功/失败计数』
//    (数据源 v3_events writeback.*)。" Delegates to
//    `server/writeback-telemetry.ts`'s `computeWritebackTelemetry`, which
//    already anticipated this exact fold (see that module's SCOPE NOTE).
//
// Scoping note: F7's five counts are scoped to the caller's `ownerEmail`
// (this app's existing single-user convention). F9's three writeback counts
// are intentionally GLOBAL (unscoped) — self-hosted/single-tenant today, this
// is fine. If this app ever goes multi-tenant, `computeWritebackTelemetry`
// would need its query to also filter on owner/org, which requires the
// underlying `writeback.*` `v3_events` rows to carry `ownerEmail`/`orgId` at
// write time (see v3-reconciler.ts's `finalizeRun` writeback hook) before
// this action can scope them — not done here since this app has exactly one
// owner today.
//
// `windowHours` (F9's field) is optional and only affects the writeback
// slice; F7's five counts have no time window (all-time state).

import { defineAction } from "@agent-native/core";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";
import { computeWritebackTelemetry } from "../server/writeback-telemetry.js";

async function countEventKind(
  db: ReturnType<typeof getV3Db>,
  ownerEmail: string,
  kind: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(v3Schema.v3Events)
    .where(
      and(
        eq(v3Schema.v3Events.ownerEmail, ownerEmail),
        eq(v3Schema.v3Events.kind, kind),
      ),
    );
  return rows[0]?.count ?? 0;
}

export default defineAction({
  description:
    "S10 health page data: telemetry-trust card (suspect-usage spawn count, " +
    "alias-drift event count, capability-degradation event count, R9 " +
    "conduction-fix count, config-inconsistency event count — any non-zero " +
    "count means that card should render yellow) PLUS the scheduler card's " +
    "writeback success/failure counters (回写:最近成功/失败计数) over the " +
    "trailing window, sourced from v3_events writeback.*. Read-only.",
  schema: z.object({
    windowHours: z.number().int().positive().optional(),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const db = getV3Db();
    const ownerEmail = resolveOwnerEmail();

    const suspectRows = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(v3Schema.v3Spawns)
      .where(
        and(
          eq(v3Schema.v3Spawns.ownerEmail, ownerEmail),
          eq(v3Schema.v3Spawns.usageSuspect, 1),
        ),
      );

    const suspectSpawns = suspectRows[0]?.count ?? 0;
    const aliasDriftEvents = await countEventKind(
      db,
      ownerEmail,
      "registry.alias-changed",
    );
    const degradedEvents = await countEventKind(
      db,
      ownerEmail,
      "capability.degraded",
    );
    // F10 (server/engine/v3-reconciler.ts) is the producer; not part of this change.
    const conductionFixes = await countEventKind(
      db,
      ownerEmail,
      "conduction.fixed",
    );
    // F0/F2's maxOutputTokens clamp point (packages/core) is the producer; not part of this change.
    const configInconsistencyEvents = await countEventKind(
      db,
      ownerEmail,
      "config.clamped",
    );

    const writeback = await computeWritebackTelemetry(args.windowHours ?? 24);

    return {
      suspectSpawns,
      aliasDriftEvents,
      degradedEvents,
      conductionFixes,
      conductionFixesPending: true,
      configInconsistencyEvents,
      configInconsistencyEventsPending: true,
      writebackFailed: writeback.writebackFailed,
      writebackStageMismatch: writeback.writebackStageMismatch,
      writebackOther: writeback.writebackOther,
      windowHours: writeback.windowHours,
    };
  },
});
