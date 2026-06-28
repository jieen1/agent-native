// v3 SPAWN reconciler — the pool-level counterpart to the brain-thread reconcile
// (server/queue/brain-thread-reconcile.ts) and the brain-task reaper
// (server/queue/brain-reap.ts).
//
// A v3_spawn row flips to 'running' when the reconciler dispatches a node, and is
// flipped to a terminal status ('done'/'failed') by the in-process spawn executor
// when the worker returns. If the orchestrator process is killed/restarted mid-
// spawn (redeploy, crash, OOM), or the parent node/run is taken terminal out of
// band (e.g. a killed msb test, a failed run that never settled its spawn), that
// 'running' spawn is STRANDED forever. The Pool page (pool.status →
// actions/v3-pool-status.ts) counts `status='running'` spawns as `busy`, so a
// single stranded spawn shows a phantom "busy VM" while nothing is executing.
//
// The same gap exists for 'pending' spawns: an orphan spawn that was created but
// never bound to a node (`node_id IS NULL`) — left from a killed test — sits at
// 'pending' forever and pollutes the Pool's `queue_waiting`.
//
// This sweep is the recovery, judged on parent-terminality + VM liveness + age,
// NEVER on the status flag alone, so a genuinely-running spawn is never reset:
//
//   • RUNNING is reset only when there is demonstrably no live microVM behind it:
//       (1) its parent node OR parent run is already TERMINAL
//           (node: done/failed/skipped; run: done/failed/cancelled), OR
//       (2) it has no live VM — runtime is not a microVM, or vm_name is NULL —
//           AND it is older than a short grace, OR
//       (3) it is older than a GENEROUS hard grace (default 30 min — longer than
//           any real spawn) regardless of the above, as a crashed-isolate
//           backstop.
//     A spawn whose parent is still active AND that has a live VM AND is within
//     grace is left alone.
//
//   • PENDING orphans (never bound to a node: `node_id IS NULL`) older than the
//     hard grace are cancelled — a created-but-never-dispatched spawn from a
//     killed test. A pending spawn that is bound to a node, or recent, is a real
//     queued dispatch and is left for the dispatcher.
//
// Disposition: a reset running spawn settles to 'failed' (it never completed); a
// reset pending orphan settles to 'cancelled' (it never ran). The parent node's
// dangling current_spawn_id is cleared so the node stops pointing at a dead spawn.
// A clear error message records that this was a reconcile, not a real failure.

import { v3DbExec, isV3PostgresConfigured } from "../db/v3.js";

/**
 * A 'running' spawn with no live VM (non-microVM runtime / NULL vm_name) is
 * eligible for reconcile only after this short grace — long enough that a spawn
 * mid-provision (vm_name not yet written) is never reset, far shorter than the
 * hard backstop. Env-overridable via V3_SPAWN_NOVM_GRACE_MS (default 2 min).
 */
export const V3_SPAWN_NOVM_GRACE_MS = (() => {
  const raw = Number(process.env.V3_SPAWN_NOVM_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60_000; // 2 min default
})();

/**
 * Hard age backstop: any 'running' spawn older than this — or any unbound
 * 'pending' orphan older than this — is reconciled regardless of VM/parent state
 * (the crashed-isolate / killed-test backstop). Generous so a real long spawn
 * never trips it. Env-overridable via V3_SPAWN_STALE_GRACE_MS (default 30 min).
 */
export const V3_SPAWN_STALE_GRACE_MS = (() => {
  const raw = Number(process.env.V3_SPAWN_STALE_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000; // 30 min default
})();

/** A reconciled (reset) v3 spawn, for caller observability. */
export interface ReconciledV3Spawn {
  id: string;
  from: string;
  to: string;
  reason: string;
}

/**
 * One v3-spawn reconcile sweep. Resets each stranded spawn so the Pool reflects
 * reality. Best-effort: never throws into the driver tick. Returns the
 * reconciled spawns.
 */
export async function reconcileV3SpawnsOnce(
  noVmGraceMs: number = V3_SPAWN_NOVM_GRACE_MS,
  staleGraceMs: number = V3_SPAWN_STALE_GRACE_MS,
): Promise<ReconciledV3Spawn[]> {
  if (!isV3PostgresConfigured()) return [];

  const staleCutoffIso = new Date(Date.now() - staleGraceMs).toISOString();
  const reconciled: ReconciledV3Spawn[] = [];

  // ── (A) Stranded RUNNING spawns ──────────────────────────────────────────
  // Candidate running spawns + their parent node/run terminality and VM liveness.
  // started_at is the spawn's own clock; coalesce to epoch so a NULL never looks
  // "recent". liveVm = a microVM runtime with a vm_name actually written.
  const runningCandidates = await v3DbExec(
    `SELECT
        s.id                AS id,
        s.node_id           AS node_id,
        s.runtime           AS runtime,
        s.vm_name           AS vm_name,
        COALESCE(s.started_at, 'epoch'::timestamptz) AS started_at,
        n.status            AS node_status,
        r.status            AS run_status
       FROM v3_spawns s
       LEFT JOIN v3_nodes n ON n.id = s.node_id
       LEFT JOIN v3_runs  r ON r.id = n.run_id
      WHERE s.status = 'running'`,
  );

  for (const row of runningCandidates.rows as Array<Record<string, unknown>>) {
    const id = String(row.id);
    const nodeId = row.node_id == null ? null : String(row.node_id);
    const runtime = row.runtime == null ? null : String(row.runtime);
    const vmName = row.vm_name == null ? null : String(row.vm_name);
    const nodeStatus = row.node_status == null ? null : String(row.node_status);
    const runStatus = row.run_status == null ? null : String(row.run_status);
    const startedAt = row.started_at
      ? new Date(String(row.started_at)).getTime()
      : 0;

    const nodeTerminal =
      nodeStatus === "done" ||
      nodeStatus === "failed" ||
      nodeStatus === "skipped";
    const runTerminal =
      runStatus === "done" ||
      runStatus === "failed" ||
      runStatus === "cancelled";
    const liveVm = runtime === "microvm" && !!vmName;

    // Reset only when there is demonstrably no live work behind this spawn:
    //   (1) parent node/run already terminal, OR
    //   (2) no live VM AND older than the short no-VM grace, OR
    //   (3) older than the hard stale backstop regardless.
    const parentTerminal = nodeTerminal || runTerminal;
    const noVmAndAged = !liveVm && startedAt < Date.now() - noVmGraceMs;
    const hardStale = startedAt < Date.now() - staleGraceMs;
    if (!parentTerminal && !noVmAndAged && !hardStale) continue;

    const ageMin = Math.round((Date.now() - startedAt) / 60_000);
    const why = parentTerminal
      ? `parent ${nodeTerminal ? `node ${nodeStatus}` : `run ${runStatus}`}`
      : noVmAndAged
        ? `no live microVM (runtime=${runtime ?? "?"}) for ~${ageMin}m`
        : `stale running spawn (~${ageMin}m)`;
    const reason = `reconciled: stranded running spawn — ${why}`;

    // Guard the write on status='running' so we never race a spawn that just
    // settled. Settle as 'failed' (it never completed). NULL out the parent
    // node's dangling current_spawn_id so the node stops pointing at a dead spawn.
    const upd = await v3DbExec(
      `UPDATE v3_spawns
          SET status = 'failed',
              error = $2,
              error_class = 'reconciled-stranded',
              completed_at = now()
        WHERE id = $1
          AND status = 'running'
        RETURNING id`,
      [
        id,
        `Reset by spawn reconcile: ${why}. The spawn was stranded 'running' ` +
          `(process restart / killed VM / parent taken terminal) with no live ` +
          `worker; cleared so the pool reflects reality.`,
      ],
    );
    if ((upd.rows?.length ?? 0) > 0) {
      if (nodeId) {
        await v3DbExec(
          `UPDATE v3_nodes SET current_spawn_id = NULL
            WHERE id = $1 AND current_spawn_id = $2`,
          [nodeId, id],
        ).catch(() => {});
      }
      reconciled.push({ id, from: "running", to: "failed", reason });
    }
  }

  // ── (B) Orphaned PENDING spawns ──────────────────────────────────────────
  // A pending spawn never bound to a node (node_id IS NULL) and older than the
  // hard grace is a created-but-never-dispatched orphan from a killed test. A
  // bound or recent pending spawn is a real queued dispatch — left alone.
  const pendingOrphans = await v3DbExec(
    `SELECT s.id AS id,
            COALESCE(s.started_at, 'epoch'::timestamptz) AS started_at
       FROM v3_spawns s
      WHERE s.status = 'pending'
        AND s.node_id IS NULL
        AND COALESCE(s.started_at, 'epoch'::timestamptz) < $1`,
    [staleCutoffIso],
  );

  for (const row of pendingOrphans.rows as Array<Record<string, unknown>>) {
    const id = String(row.id);
    const startedAt = row.started_at
      ? new Date(String(row.started_at)).getTime()
      : 0;
    const ageMin = Math.round((Date.now() - startedAt) / 60_000);
    const reason = `reconciled: orphaned pending spawn (no node, ~${ageMin}m)`;
    const upd = await v3DbExec(
      `UPDATE v3_spawns
          SET status = 'cancelled',
              error = $2,
              error_class = 'reconciled-orphan',
              completed_at = now()
        WHERE id = $1
          AND status = 'pending'
          AND node_id IS NULL
        RETURNING id`,
      [
        id,
        `Reset by spawn reconcile: pending spawn never bound to a node ` +
          `(orphan from a killed/aborted dispatch); cancelled so the pool ` +
          `queue reflects reality.`,
      ],
    );
    if ((upd.rows?.length ?? 0) > 0) {
      reconciled.push({ id, from: "pending", to: "cancelled", reason });
    }
  }

  if (reconciled.length > 0) {
    console.warn(
      `[v3-spawn-reconcile] reset ${reconciled.length} stranded spawn(s): ` +
        reconciled.map((r) => `${r.id}(${r.from}→${r.to})`).join(", "),
    );
  }

  return reconciled;
}
