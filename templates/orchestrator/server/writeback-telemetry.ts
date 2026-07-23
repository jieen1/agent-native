// F9 (orchestrator half) — writeback counters for the S10 health page.
//
// Design authority: docs/sdlc-impl-f5-f10.md §5B: "S10 健康页『调度器』卡加一
// 行『回写:最近成功/失败计数』(数据源 v3_events writeback.*)。"
//
// SCOPE NOTE (F7 overlap — read before touching `actions/health-telemetry.ts`):
// F7 (docs/sdlc-impl-f5-f10.md §3A) separately specifies a FULL `health-
// telemetry.ts` action backing a DIFFERENT card — the "S10·遥测可信卡"
// (telemetry trust card): `{suspectSpawns, aliasDriftEvents, degradedEvents,
// conductionFixes, configInconsistencyEvents}`. That card's data sources
// (`v3_model_registry` table, `v3_spawns.usage_suspect`/`model_real_name`
// columns, `brain_threads.closing_anomaly`, `registry.alias-changed` /
// `capability.degraded` events) do NOT exist on this branch/worktree — F7
// lives on a separate, not-yet-merged line of work. Rather than fabricate
// stand-ins for counters this task doesn't own, this module + the
// `health-telemetry.ts` action it backs implement ONLY the writeback slice
// (F9's own card: "调度器" scheduler card, not the trust card). When F7's
// branch merges, its fuller `health-telemetry.ts` and this one both claim the
// same action name — reconcile by folding this module's counts in as
// additional fields on F7's response (or vice versa), not by shipping two
// competing actions. Flagged in the delivery report.
//
// Counting convention: every writeback attempt (success or failure) leaves a
// `v3_events` row whose `kind` is one of:
//   - "writeback.run-meta"        (writeback-run-meta backfill succeeded)
//   - "writeback.exec-state"      (non-terminal execState transition, e.g.
//                                  target=running — written by the tracker's
//                                  own writeback-exec-state action, not this
//                                  app; included here for completeness of the
//                                  "writeback.*" prefix scan even though this
//                                  app never observes it directly)
//   - "writeback.stage-mismatch"  (advance-stage's fromStage assertion no-op —
//                                  tracker-side event; visible here as a
//                                  distinct row, not counted as failure)
//   - "writeback.failed"          (this app's own event — see v3-reconciler.ts
//                                  `finalizeRun`'s writeback hook — written
//                                  after `attemptWithBackoff` exhausts retries)
//   - "writeback.permanently-failed" (2026-07-23 incident fix: this app's own
//                                  event, written ONCE when a row is
//                                  classified permanently un-retryable or
//                                  exceeds the attempt cap and moves to
//                                  writebackStatus:'failed' — see
//                                  v3-reconciler.ts's attemptWritebackDelivery.
//                                  Distinct from ordinary "writeback.failed"
//                                  so a genuinely gave-up run is visible on
//                                  its own, not buried in the retry-noise
//                                  count.)
// "writeback.failed" and "writeback.permanently-failed" are THIS app's own
// event kinds (the others are recorded on the tracker side, in the tracker's
// own activities table, not here). The query is written against the full
// "writeback.%" prefix (not a literal-only filter) so it stays correct if a
// future orchestrator-side writeback event kind is added.

import { and, gte, like } from "drizzle-orm";

import { getV3Db, v3Schema } from "./db/index.js";

export interface WritebackTelemetry {
  /** Count of `writeback.failed` events in the window — ONE retry attempt
   * failed (still retryable — includes attempts on rows that later succeed
   * or later permanently fail; NOT the same as writebackPermanentlyFailed). */
  writebackFailed: number;
  /** Count of `writeback.permanently-failed` events in the window — a run
   * gave up for good (classified un-retryable, or exceeded the attempt cap)
   * and needs a HUMAN look (a real bug, a deleted work item, etc.) —
   * 2026-07-23 incident fix. This is the number that should alarm an
   * operator; writebackFailed alone is expected retry noise. */
  writebackPermanentlyFailed: number;
  /** Count of `writeback.stage-mismatch` events in the window — a no-op the
   * tracker recorded for visibility (item wasn't at the expected stage), not
   * a failure. */
  writebackStageMismatch: number;
  /** All other `writeback.*` events in the window (nominal successes). */
  writebackOther: number;
  windowHours: number;
}

/**
 * Compute writeback event counts over the trailing `windowHours` for the S10
 * health page's "调度器" card. Read-only, best-effort (an empty/absent table
 * degrades to all-zero rather than throwing — health pages must never break
 * on a query fluke).
 */
export async function computeWritebackTelemetry(
  windowHours: number = 24,
): Promise<WritebackTelemetry> {
  const db = getV3Db();
  const since = new Date(Date.now() - windowHours * 3600 * 1000);

  let rows: Array<{ kind: string }> = [];
  try {
    rows = await db
      .select({ kind: v3Schema.v3Events.kind })
      .from(v3Schema.v3Events)
      .where(
        and(
          like(v3Schema.v3Events.kind, "writeback.%"),
          gte(v3Schema.v3Events.ts, since),
        ),
      )
      .limit(10_000);
  } catch {
    // DB unreachable / table not migrated — health page shows zeros, not an
    // error page.
    rows = [];
  }

  let writebackFailed = 0;
  let writebackPermanentlyFailed = 0;
  let writebackStageMismatch = 0;
  let writebackOther = 0;
  for (const row of rows) {
    if (row.kind === "writeback.failed") writebackFailed++;
    else if (row.kind === "writeback.permanently-failed")
      writebackPermanentlyFailed++;
    else if (row.kind === "writeback.stage-mismatch") writebackStageMismatch++;
    else writebackOther++;
  }

  return {
    writebackFailed,
    writebackPermanentlyFailed,
    writebackStageMismatch,
    writebackOther,
    windowHours,
  };
}
