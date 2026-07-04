// v3-run-reconcile-sweep — periodic runtime sweep for stranded v3_runs.
//
// Problem: after reconciler restart storms or node-finalize event loss, a
// v3_run can sit in 'running'/'pending' even though ALL its v3_nodes have
// reached terminal states (done/failed/skipped). brain-monitor.ts wakes brain
// threads based on non-terminal RUN status, not node status (see
// server/brain/brain-monitor.ts monitorSweepOnce()'s
// `WHERE r.status NOT IN ('done','failed','cancelled')`), so a stuck run keeps
// waking its bound brain thread forever, wasting CC/tokens on a session that
// has nothing left to do.
//
// reconcileV3OnStartup (server/recovery/v3-reconcile.ts) only runs once, at
// boot — it cannot self-heal a run that gets stuck WHILE the server keeps
// running. This module is that runtime backstop: a periodic sweep that finds
// such stranded runs and forces the existing reconciler to re-tick them via
// triggerTickSafe(), which triggers the reconciler's own (already-tested,
// idempotent) finalizeRun logic. This module NEVER reimplements
// terminal-status or finalize logic — it only decides WHEN to ask the
// reconciler to look again.
//
// Design notes:
//  - Terminal node statuses mirror the private TERMINAL_STATUSES set in
//    server/engine/v3-reconciler.ts (done/failed/skipped) — duplicated here
//    only as the well-known set of three strings, purely to decide whether a
//    run is a sweep candidate. The actual done-vs-failed transition is still
//    entirely decided by the reconciler's tick()/finalizeRun().
//  - Only targets 'pending'/'running' runs. 'paused' is intentionally left
//    alone — tick() already no-ops on paused runs, but a paused run reflects a
//    deliberate user pause, not a stuck state, so it's not queried at all.
//  - A run with zero nodes is skipped (not treated as stranded): a brand new
//    run may not have its v3_nodes rows inserted yet, and there is no
//    timestamp to judge "silence" from. tick() itself finalizes an empty DAG
//    to "done" immediately on the next real trigger, so no sweep help is
//    needed there.
//  - Silence threshold (V3_NODES_SILENT_THRESHOLD_MS, default 30s) avoids
//    racing the normal event-driven tick that runs immediately after a node
//    finishes — only runs whose nodes have been quiet past this threshold are
//    considered "stuck" rather than merely "between events".
//  - Modeled on server/brain/brain-monitor.ts (durable, unref'd setInterval,
//    best-effort per-item error swallowing, idempotent start/stop).

import { and, eq, inArray } from "drizzle-orm";
import { getV3Db, isV3PostgresConfigured } from "../db/v3.js";
import { v3Runs, v3Nodes } from "../db/v3-schema.js";
import { triggerTickSafe } from "../plugins/v3-reconciler.js";

/**
 * Terminal node statuses — mirrors engine/v3-reconciler.ts's TERMINAL_STATUSES.
 * Exported (read-only) purely so unit tests can assert on the exact set
 * without duplicating it inline.
 */
export const TERMINAL_NODE_STATUSES = ["done", "failed", "skipped"] as const;

/**
 * Run statuses this sweep considers as sweep candidates ('paused' excluded).
 * Exported (read-only) purely so unit tests can assert on the exact set
 * without duplicating it inline.
 */
export const CANDIDATE_RUN_STATUSES = ["pending", "running"] as const;

/**
 * How often (ms) to run the reconcile sweep.
 * Env: V3_RUN_RECONCILE_SWEEP_INTERVAL_MS
 * Default: 90 000 ms (90s) — within the requested 60-120s window.
 */
export function defaultSweepIntervalMs(): number {
  const raw = process.env.V3_RUN_RECONCILE_SWEEP_INTERVAL_MS;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 90_000;
}

/**
 * Silence threshold (ms): a run whose nodes' most recent activity timestamp
 * is at least this old is considered "stuck" rather than "still being
 * processed by the normal event-driven tick".
 * Env: V3_NODES_SILENT_THRESHOLD_MS. Default: 30 000 ms (30s).
 */
export function defaultNodesSilentThresholdMs(): number {
  const raw = process.env.V3_NODES_SILENT_THRESHOLD_MS;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

/**
 * Run one sweep iteration: find stranded v3_runs and force-reconcile them.
 *
 * A "stranded" run is one where:
 *  1. v3_runs.status IN ('pending', 'running')
 *  2. it has at least one v3_nodes row, and ALL of them have status IN
 *     ('done', 'failed', 'skipped')
 *  3. the most recent node activity (completedAt, falling back to startedAt)
 *     is at least `defaultNodesSilentThresholdMs()` in the past
 *
 * For each stranded run found, calls triggerTickSafe() so the EXISTING
 * reconciler path finalizes the run — finalizeRun is idempotent (checks
 * current status before writing), so re-ticking is always safe.
 *
 * Returns the ids of runs that were re-ticked (for logging/tests).
 * Best-effort: a single run's failure never blocks the rest of the sweep.
 */
export async function reconcileStrandedV3RunsOnce(): Promise<string[]> {
  if (!isV3PostgresConfigured()) return [];

  const db = getV3Db();
  const silentThresholdMs = defaultNodesSilentThresholdMs();
  const now = Date.now();
  const reconciled: string[] = [];

  const candidateRuns = await db
    .select({ id: v3Runs.id, status: v3Runs.status })
    .from(v3Runs)
    .where(inArray(v3Runs.status, [...CANDIDATE_RUN_STATUSES]));

  for (const run of candidateRuns) {
    try {
      // Bail early only if a node is actively RUNNING — that run is genuinely
      // being processed (an agent is mid-flight), so re-ticking would be
      // pointless. A run whose remaining non-terminal nodes are all `pending`
      // (or `awaiting-approval`) with NOTHING running is either fully terminal
      // (all nodes resolved) OR stalled: the event-driven tick after the last
      // node finished did not dispatch the next ready node (multi-stage brain
      // orchestration and directly-launched multi-node DAGs both hit this — a
      // node completes but the chained tick is lost, so develop:done leaves
      // review:pending forever). In BOTH cases a re-tick is the right, safe,
      // idempotent action: tick() dispatches any ready pending node (advancing
      // a stalled run) or finalizes an all-terminal run.
      const [running] = await db
        .select({ id: v3Nodes.id })
        .from(v3Nodes)
        .where(and(eq(v3Nodes.runId, run.id), eq(v3Nodes.status, "running")))
        .limit(1);

      if (running) continue;

      // Fetch all nodes once to (a) confirm at least one exists and (b) find
      // the most recent activity timestamp for the silence check.
      const nodes = await db
        .select({
          status: v3Nodes.status,
          startedAt: v3Nodes.startedAt,
          completedAt: v3Nodes.completedAt,
        })
        .from(v3Nodes)
        .where(eq(v3Nodes.runId, run.id));

      // Zero-node run: nothing has been dispatched yet — not a stranded run,
      // and there is no timestamp to judge silence from. Skip.
      if (nodes.length === 0) continue;

      let lastActivityMs = 0;
      for (const n of nodes) {
        const ts = n.completedAt ?? n.startedAt;
        if (ts) {
          const ms = new Date(ts).getTime();
          if (ms > lastActivityMs) lastActivityMs = ms;
        }
      }
      // No timestamps at all — can't judge silence yet; skip to be safe.
      if (lastActivityMs === 0) continue;
      if (now - lastActivityMs < silentThresholdMs) continue;

      const pendingCount = nodes.filter(
        (n) => !TERMINAL_NODE_STATUSES.includes(n.status as never),
      ).length;
      console.log(
        `[v3-run-reconcile-sweep] stuck run detected: ${run.id} ` +
          `(status=${run.status}, ${nodes.length} node(s), ` +
          `${pendingCount} non-terminal & none running, ` +
          `silent for ${now - lastActivityMs}ms) — re-ticking`,
      );

      // Re-tick via the exact same path every other caller uses. The
      // reconciler's tick() re-reads nodes and either dispatches the next
      // ready node (advancing a stalled run) or, when all are resolved, calls
      // its own idempotent finalizeRun(). triggerTickSafe never throws.
      await triggerTickSafe(run.id);
      reconciled.push(run.id);
    } catch (err) {
      // One run's failure must never block the rest of the sweep.
      console.warn(
        `[v3-run-reconcile-sweep] failed to reconcile run ${run.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (reconciled.length > 0) {
    console.log(
      `[v3-run-reconcile-sweep] sweep complete: ${reconciled.length} ` +
        `run(s) reconciled out of ${candidateRuns.length} candidate(s)`,
    );
  }

  return reconciled;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the durable runtime reconcile sweep. Idempotent — a second call is a
 * no-op. The loop is `unref`-ed so it never blocks process shutdown (modeled
 * on server/brain/brain-monitor.ts's startBrainMonitorTick).
 */
export function startReconcileSweep(
  intervalMs: number = defaultSweepIntervalMs(),
): void {
  if (!isV3PostgresConfigured()) return;
  if (timer) return;

  timer = setInterval(() => {
    void reconcileStrandedV3RunsOnce().catch((err) => {
      console.warn(
        "[v3-run-reconcile-sweep] sweep error:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  console.log(
    `[v3-run-reconcile-sweep] started ` +
      `(interval=${intervalMs}ms, node-silence-threshold=${defaultNodesSilentThresholdMs()}ms)`,
  );
}

/** Stop the reconcile sweep timer (test cleanup / shutdown). */
export function stopReconcileSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
