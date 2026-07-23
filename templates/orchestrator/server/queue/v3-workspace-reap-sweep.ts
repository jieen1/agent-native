// v3-workspace-reap-sweep — periodic reclaim of workspace checkouts whose
// work is done.
//
// Root cause (2026-07-20 disk-full incident, task board #53): destroyLocalWorkspace()
// was fixed to actually `rm -rf` a workspace's checkout (see
// ../v3-workspace-local.ts), and a one-off script
// (scripts/reclaim-stale-workspaces.mts) cleared the backlog that had already
// accumulated (174 checkouts, ~48.5GB). But NOTHING calls
// destroyLocalWorkspace/workspaceDestroy automatically once a workspace's work
// concludes — it is not in the brain's tool list (server/brain/brain-prompt.ts),
// no DAG template step calls it, and no sweep existed. Every workspace created
// since the incident piled right back up in 'ready'/'error' state (64 of them,
// ~44GB, by 2026-07-22 — confirmed via a direct v3_workspaces query), exactly
// reproducing the disk-growth trajectory the fix was supposed to have stopped.
// The rm -rf mechanism itself has been correct since the incident fix — this
// sweep is the missing TRIGGER, mirrored on v3-run-reconcile-sweep.ts's
// "decide WHEN, never reimplement the underlying action" shape.
//
// A workspace is reclaimable when:
//   1. its own state will never usefully change again — IN
//      RECLAIMABLE_WORKSPACE_STATES ('ready'|'error'|'failed'|'destroying';
//      mirrors the one-off script's candidate set — 'provisioning' is
//      deliberately excluded, matching that script's own reasoning: a
//      workspace mid-creation is the one state where "still needed" is
//      genuinely ambiguous with no live process to ask), AND
//   2. every run that ever spawned against it (v3_spawns.workspace_id ->
//      v3_nodes.run_id -> v3_runs) has reached a terminal status
//      (done/failed/cancelled) — a workspace with zero runs ever recorded
//      against it counts as vacuously "all terminal" too (created but never
//      used), AND
//   3. the grace period has elapsed since the LATEST such run's completedAt,
//      falling back to the workspace's own createdAt when it has no runs at
//      all — long enough that a human/brain can still inspect a
//      just-finished workspace, short enough to actually bound disk growth,
//      AND
//   4. no `brain_threads` row still references it with a non-terminal wake
//      status ('running'|'idle' — only 'done'|'error' are terminal). A
//      workspace can be held by an active brain THREAD with zero v3_spawns
//      rows (analysis phase, no DAG dispatched yet) or between a run going
//      terminal and the brain's own slow review/commit turn — condition 2
//      alone cannot see this (Codex review 2026-07-23: this sweep's own
//      addition of automatic rm -rf introduced a new risk of deleting a
//      workspace out from under a live brain session).

import { isPostgres } from "@agent-native/core/db";
import { sql } from "drizzle-orm";

import { getV3Db } from "../db/index.js";
import { destroyLocalWorkspace } from "../v3-workspace-local.js";

/** Workspace states this sweep considers reclaimable candidates. */
export const RECLAIMABLE_WORKSPACE_STATES = [
  "ready",
  "error",
  "failed",
  "destroying",
] as const;

/**
 * How often (ms) to run the workspace reap sweep.
 * Env: V3_WORKSPACE_REAP_INTERVAL_MS. Default: 300 000 ms (5 min) — disk
 * pressure is not a sub-second concern; a coarse cadence is plenty.
 */
export function defaultWorkspaceReapIntervalMs(): number {
  const raw = process.env.V3_WORKSPACE_REAP_INTERVAL_MS;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 300_000;
}

/**
 * Grace period (ms) after a workspace's last associated run activity before
 * it is reclaimed. Env: V3_WORKSPACE_REAP_GRACE_MS. Default: 2 hours.
 */
export function defaultWorkspaceReapGraceMs(): number {
  const raw = process.env.V3_WORKSPACE_REAP_GRACE_MS;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 2 * 60 * 60 * 1000;
}

interface WorkspaceReapCandidateRow {
  id: string;
  created_at: string | Date;
  active_run_count: string | number;
  last_run_completed_at: string | Date | null;
}

/**
 * Run one sweep iteration: find reclaimable workspaces and destroy them.
 * Returns the ids of workspaces actually destroyed (for logging/tests).
 * Best-effort throughout — a single workspace's failure never blocks the
 * rest of the sweep, and a query failure degrades to an empty sweep rather
 * than throwing (mirrors v3-run-reconcile-sweep.ts's discipline).
 */
export async function reapStaleWorkspacesOnce(): Promise<string[]> {
  if (!isPostgres()) return [];

  const db = getV3Db();
  const graceMs = defaultWorkspaceReapGraceMs();
  const now = Date.now();
  const reaped: string[] = [];

  let rows: WorkspaceReapCandidateRow[];
  try {
    rows = (await db.execute(sql`
      SELECT
        w.id AS id,
        w.created_at AS created_at,
        COUNT(r.id) FILTER (WHERE r.status NOT IN ('done', 'failed', 'cancelled')) AS active_run_count,
        MAX(r.completed_at) AS last_run_completed_at
      FROM v3_workspaces w
      LEFT JOIN v3_spawns sp ON sp.workspace_id = w.id
      LEFT JOIN v3_nodes n ON n.id = sp.node_id
      LEFT JOIN v3_runs r ON r.id = n.run_id
      WHERE w.host_path IS NOT NULL
        AND w.state IN ('ready', 'error', 'failed', 'destroying')
        -- Codex review 2026-07-23 (new risk introduced by this sweep itself):
        -- a workspace held by an active brain THREAD (analysis phase, no DAG
        -- spawned yet; or a run just went terminal but the brain's own
        -- review/commit turn is still slow) has no v3_spawns row yet, so the
        -- join above alone would let it fall through the active-run check and
        -- get rm -rf'd out from under the brain mid-session. brain_threads.status
        -- is 'running'|'idle'|'done'|'error' — 'idle' still means alive
        -- (between turns, will wake again), so only done/error are terminal.
        AND NOT EXISTS (
          SELECT 1 FROM brain_threads bt
          WHERE bt.workspace_id = w.id
            AND bt.status NOT IN ('done', 'error')
        )
      GROUP BY w.id, w.created_at
    `)) as unknown as WorkspaceReapCandidateRow[];
  } catch (err) {
    console.warn(
      "[v3-workspace-reap-sweep] candidate query failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }

  for (const row of rows) {
    try {
      const activeRunCount = Number(row.active_run_count ?? 0);
      if (activeRunCount > 0) continue; // still genuinely in use

      const lastActivityMs = row.last_run_completed_at
        ? new Date(row.last_run_completed_at).getTime()
        : new Date(row.created_at).getTime();
      if (!Number.isFinite(lastActivityMs)) continue;
      if (now - lastActivityMs < graceMs) continue; // grace period not elapsed

      await destroyLocalWorkspace(row.id);
      reaped.push(row.id);
    } catch (err) {
      console.warn(
        `[v3-workspace-reap-sweep] failed to reap workspace ${row.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (reaped.length > 0) {
    console.log(
      `[v3-workspace-reap-sweep] reclaimed ${reaped.length} stale workspace(s): ${reaped.join(", ")}`,
    );
  }

  return reaped;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the durable workspace reap sweep. Idempotent — a second call is a
 * no-op. The loop is `unref`-ed so it never blocks process shutdown (modeled
 * on server/brain/brain-monitor.ts's startBrainMonitorTick).
 */
export function startWorkspaceReapSweep(
  intervalMs: number = defaultWorkspaceReapIntervalMs(),
): void {
  if (!isPostgres()) return;
  if (timer) return;

  timer = setInterval(() => {
    void reapStaleWorkspacesOnce().catch((err) => {
      console.warn(
        "[v3-workspace-reap-sweep] sweep error:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  console.log(
    `[v3-workspace-reap-sweep] started ` +
      `(interval=${intervalMs}ms, grace=${defaultWorkspaceReapGraceMs()}ms)`,
  );
}

/** Stop the workspace reap sweep timer (test cleanup / shutdown). */
export function stopWorkspaceReapSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
