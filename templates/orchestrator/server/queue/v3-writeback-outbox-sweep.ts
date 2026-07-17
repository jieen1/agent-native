// v3-writeback-outbox-sweep — periodic drain of the persistent writeback
// outbox (task board #38 follow-up: "回写通道 fire-and-forget 无持久补偿(改持久
// outbox)", deferred from the earlier F9-B review).
//
// Problem this closes: F9's original terminal hook (v3-reconciler.ts's
// finalizeRun -> writebackOnTerminal) fired the tracker writeback
// fire-and-forget, with its own retry/backoff running fully detached from the
// tick loop. If the process crashed or was redeployed DURING that detached
// backoff window, the writeback (and its own `writeback.failed` event) was
// lost permanently — nothing persisted the fact that a writeback was still
// owed, so nothing ever retried it.
//
// The fix (reliable-mutations pattern, mirroring the EXISTING
// v3-run-reconcile-sweep.ts self-heal-via-reconcile-sweep shape rather than
// inventing a new mechanism): the moment a tracker-dispatched run reaches a
// terminal state, finalizeRun durably persists a "writeback owed" outbox row
// on v3_runs (writeback_status='pending' + the classified outcome) in an
// AWAITED step, BEFORE firing the fire-and-forget fast-path delivery
// attempt. This sweep is the backstop: it periodically asks the reconciler
// singleton to drain every row still writeback_status='pending' — whether
// because the fast path never got a chance to run (crash before
// finalizeRun's fire-and-forget started), never finished (crash mid-backoff
// — the exact gap this fix closes), or genuinely failed (tracker was down).
// A pending row is NEVER silently abandoned: each sweep tick retries every
// pending row again, uncapped.
//
// Like v3-run-reconcile-sweep.ts, this module never reimplements delivery
// logic — it only decides WHEN to ask the reconciler to drain. The judgment
// of WHICH rows are pending and HOW to attempt/mark them lives entirely in
// V3Reconciler.drainWritebackOutbox() (server/engine/v3-reconciler.ts) via
// triggerWritebackDrainSafe() (server/plugins/v3-reconciler.ts) — exactly the
// "sweep decides WHEN, reconciler decides HOW" split the R9 conduction sweep
// already established for stranded runs.

import { isPostgres } from "@agent-native/core/db";

import { triggerWritebackDrainSafe } from "../plugins/v3-reconciler.js";

/**
 * How often (ms) to drain the writeback outbox.
 * Env: V3_WRITEBACK_OUTBOX_SWEEP_INTERVAL_MS
 * Default: 60 000 ms (60s) — the fast path already delivers the common case
 * near-instantly; this interval only bounds how long a crash-orphaned or
 * still-failing row can go before the next retry.
 */
export function defaultWritebackOutboxSweepIntervalMs(): number {
  const raw = process.env.V3_WRITEBACK_OUTBOX_SWEEP_INTERVAL_MS;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/**
 * Run one sweep iteration: ask the reconciler singleton to drain every
 * pending writeback outbox row. Best-effort — never throws (
 * `triggerWritebackDrainSafe` swallows its own errors).
 */
export async function runWritebackOutboxSweepOnce(): Promise<void> {
  if (!isPostgres()) return;
  await triggerWritebackDrainSafe();
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the durable runtime writeback-outbox sweep. Idempotent — a second
 * call is a no-op. The loop is `unref`-ed so it never blocks process
 * shutdown (modeled on v3-run-reconcile-sweep.ts's startReconcileSweep).
 */
export function startWritebackOutboxSweep(
  intervalMs: number = defaultWritebackOutboxSweepIntervalMs(),
): void {
  if (!isPostgres()) return;
  if (timer) return;

  timer = setInterval(() => {
    void runWritebackOutboxSweepOnce().catch((err) => {
      console.warn(
        "[v3-writeback-outbox-sweep] sweep error:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  console.log(`[v3-writeback-outbox-sweep] started (interval=${intervalMs}ms)`);
}

/** Stop the writeback-outbox sweep timer (test cleanup / shutdown). */
export function stopWritebackOutboxSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
