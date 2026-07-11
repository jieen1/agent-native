// S10 telemetry-trust card data source (04 §10). Reads the current state of
// the F7 usage-attribution contract: suspect-usage spawns, alias-drift
// events, capability-degradation events, R9 conduction fixes, and
// config-inconsistency events. Any non-zero count means the card should
// render yellow (all zero = green). Suspect data must never be silently
// folded into aggregated metrics elsewhere (degree/insights pages) — this
// action is the readable proof that it is being tracked instead.
//
// `conductionFixes` (F10's spawn->node reconciler transition) and
// `configInconsistencyEvents` (the maxOutputTokens-clamp / env-override
// point, owned by F0/F2's clamp code in packages/core) read v3_events kinds
// whose PRODUCERS are not part of this change — see the doc's own note that
// wiring those producers is a cross-feature dependency. Both therefore
// report a real (currently-always-0) count plus `pending: true` rather than
// a false all-clear, so the UI can distinguish "confirmed zero" from
// "nothing emits this yet".

import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";

async function countEventKind(
  db: ReturnType<typeof getV3Db>,
  ownerEmail: string,
  kind: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(v3Schema.v3Events)
    .where(
      and(eq(v3Schema.v3Events.ownerEmail, ownerEmail), eq(v3Schema.v3Events.kind, kind)),
    );
  return rows[0]?.count ?? 0;
}

export default defineAction({
  description:
    "S10 telemetry-trust card data: suspect-usage spawn count, alias-drift " +
    "event count, capability-degradation event count, R9 conduction-fix " +
    "count, and config-inconsistency event count (04 §10). Any non-zero " +
    "count means the card should render yellow.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
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
    const aliasDriftEvents = await countEventKind(db, ownerEmail, "registry.alias-changed");
    const degradedEvents = await countEventKind(db, ownerEmail, "capability.degraded");
    // F10 (server/engine/v3-reconciler.ts) is the producer; not part of this change.
    const conductionFixes = await countEventKind(db, ownerEmail, "conduction.fixed");
    // F0/F2's maxOutputTokens clamp point (packages/core) is the producer; not part of this change.
    const configInconsistencyEvents = await countEventKind(db, ownerEmail, "config.clamped");

    return {
      suspectSpawns,
      aliasDriftEvents,
      degradedEvents,
      conductionFixes,
      conductionFixesPending: true,
      configInconsistencyEvents,
      configInconsistencyEventsPending: true,
    };
  },
});
