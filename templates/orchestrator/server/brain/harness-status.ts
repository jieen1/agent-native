// Brain harness status — the S9 "能力降级" (capability degraded) red card's
// data source (04 §6/§7, SDLC-049 "降级显式化不变量").
//
// `evaluateBrainHarness()` (brain-session.ts) already computes whether THIS
// PROCESS could run a turn through the harness right now; this module adds
// the durable side — the latest `capability.degraded` v3_events row (written
// by `recordHarnessDegradation` every time a turn actually hit the degraded
// branch) — so the console can show a real reason/timestamp instead of only
// the live env-flag check, and so the card still reads correctly on a page
// load that races the next brain wake.
//
// Row-fetch-then-reduce-in-JS (mirrors writeback-telemetry.ts's
// computeWritebackTelemetry) rather than a SQL aggregate — keeps this
// trivially unit-testable with the same select/from/where/limit mock chain
// the rest of this app's telemetry modules use, and degrades to "no event
// found" instead of throwing when the table/query has an issue.

import { and, desc, eq } from "drizzle-orm";

import { getV3Db, v3Schema } from "../db/index.js";
import { evaluateBrainHarness } from "./brain-session.js";

export interface BrainHarnessDegradedEvent {
  reason: string | null;
  threadId: string | null;
  ts: string | null;
}

export interface BrainHarnessStatus {
  /** Raw opt-in env flag (ORCH_BRAIN_HARNESS=1), independent of usability. */
  harnessRequested: boolean;
  /** Whether the harness path is ACTUALLY usable this turn. */
  enabled: boolean;
  /** Non-null only when opted in but currently unusable — a LIVE degradation. */
  degradedReason: string | null;
  /** The most recent capability.degraded event recorded for this owner, if any. */
  lastEvent: BrainHarnessDegradedEvent | null;
  /** Total capability.degraded events on record for this owner (all-time). */
  eventCount: number;
}

/**
 * Compute the brain console's capability-degradation status: the live
 * env/package check PLUS the durable event trail. Best-effort — a DB read
 * failure degrades to "no historical event" rather than throwing (this backs
 * a console card, never allowed to break the page).
 */
export async function getBrainHarnessStatus(
  ownerEmail: string,
): Promise<BrainHarnessStatus> {
  const evalResult = evaluateBrainHarness();

  let rows: Array<{
    payload: unknown;
    ts: Date | null;
  }> = [];
  try {
    const db = getV3Db();
    rows = await db
      .select({
        payload: v3Schema.v3Events.payload,
        ts: v3Schema.v3Events.ts,
      })
      .from(v3Schema.v3Events)
      .where(
        and(
          eq(v3Schema.v3Events.ownerEmail, ownerEmail),
          eq(v3Schema.v3Events.kind, "capability.degraded"),
        ),
      )
      .orderBy(desc(v3Schema.v3Events.ts))
      .limit(200);
  } catch {
    rows = [];
  }

  const [latest] = rows;
  const lastEvent: BrainHarnessDegradedEvent | null = latest
    ? {
        reason: (latest.payload as { reason?: string } | null)?.reason ?? null,
        threadId:
          (latest.payload as { threadId?: string } | null)?.threadId ?? null,
        ts: latest.ts ? new Date(latest.ts).toISOString() : null,
      }
    : null;

  return {
    harnessRequested: process.env.ORCH_BRAIN_HARNESS === "1",
    enabled: evalResult.enabled,
    degradedReason: evalResult.degradedReason,
    lastEvent,
    eventCount: rows.length,
  };
}

/**
 * Thread ids that have at least one capability.degraded event on record for
 * this owner — backs the brain-threads rail's "degraded" badge (04 §7 "受影响
 * 线程带 degraded 徽标"). Best-effort: a DB read failure returns an empty set
 * rather than throwing (the rail must still render).
 */
export async function getDegradedThreadIds(
  ownerEmail: string,
): Promise<Set<string>> {
  try {
    const db = getV3Db();
    const rows = await db
      .select({ payload: v3Schema.v3Events.payload })
      .from(v3Schema.v3Events)
      .where(
        and(
          eq(v3Schema.v3Events.ownerEmail, ownerEmail),
          eq(v3Schema.v3Events.kind, "capability.degraded"),
        ),
      )
      .limit(500);
    const ids = new Set<string>();
    for (const row of rows) {
      const threadId = (row.payload as { threadId?: string } | null)?.threadId;
      if (threadId) ids.add(threadId);
    }
    return ids;
  } catch {
    return new Set();
  }
}
