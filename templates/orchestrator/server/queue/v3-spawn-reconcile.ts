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
// reset pending orphan settles to 'cancelled' (it never ran).
//
// R9 conduction (docs/sdlc-product-design/02-workflows.md §4, SDLC-050): when
// the parent node is NOT already terminal, its dangling current_spawn_id is
// deliberately left pointing at the now-failed spawn — NOT nulled here —
// because server/engine/v3-reconciler.ts's tick() conduction rule reads
// exactly that pointer to decide retry-vs-fail for the node. Nulling it in
// this sweep would erase the evidence that rule depends on and leave the node
// stranded 'running' forever (the original SDLC-050 bug). Instead, this sweep
// calls triggerTickSafe() for the node's run so the reconciler picks it up on
// its very next tick. When the parent node IS already terminal (or the spawn
// was never bound to a node), the pointer is cleared immediately as before —
// there is no node left to migrate, so clearing it here is just Pool-page
// hygiene.

import { isPostgres } from "@agent-native/core/db";

import { getDbExec } from "../db/index.js";
import { triggerTickSafe } from "../plugins/v3-reconciler.js";

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

/**
 * R9 (02-workflows.md §4) runtime liveness signal: a 'running' spawn has no
 * live handle to poll (in-process registry is gone across a restart, and
 * there is no OS-level PID for a vLLM/OM-style network spawn — see F1–F4 §6),
 * so the spawn's OWN event stream (`v3_events` rows keyed by spawn_id) is the
 * heartbeat: F2 guarantees a live worker keeps emitting events. When no event
 * has landed for longer than this threshold, the spawn is stranded even if it
 * still has a live-looking microVM (a network black-hole between the
 * orchestrator and the worker leaves `vm_name` set with nothing behind it) —
 * this check fires independently of the no-VM-grace / hard-stale backstops
 * above, catching that case far faster than the 30-minute hard backstop
 * would. Env-overridable via ORCH_SPAWN_STALL_MS (default 120s).
 */
export const ORCH_SPAWN_STALL_MS = (() => {
  const raw = Number(process.env.ORCH_SPAWN_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60_000; // 120s default
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
  stallMs: number = ORCH_SPAWN_STALL_MS,
): Promise<ReconciledV3Spawn[]> {
  if (!isPostgres()) return [];

  const staleCutoffIso = new Date(Date.now() - staleGraceMs).toISOString();
  const reconciled: ReconciledV3Spawn[] = [];
  // Runs whose stranded-running spawn left a non-terminal node behind — must
  // be re-ticked so server/engine/v3-reconciler.ts's R9 conduction rule can
  // migrate the node (see the file header comment for why current_spawn_id is
  // deliberately NOT nulled for these).
  const runsToRetick = new Set<string>();

  // ── (A) Stranded RUNNING spawns ──────────────────────────────────────────
  // Candidate running spawns + their parent node/run terminality and VM
  // liveness, plus the spawn's own last v3_events timestamp (the heartbeat —
  // see ORCH_SPAWN_STALL_MS above). started_at is the spawn's own clock;
  // coalesce to epoch so a NULL never looks "recent". liveVm = a microVM
  // runtime with a vm_name actually written.
  const runningCandidates = await getDbExec().execute(
    `SELECT
        s.id                AS id,
        s.node_id           AS node_id,
        s.runtime           AS runtime,
        s.vm_name           AS vm_name,
        COALESCE(s.started_at, 'epoch'::timestamptz) AS started_at,
        n.status            AS node_status,
        n.run_id            AS run_id,
        r.status            AS run_status,
        (SELECT MAX(ts) FROM v3_events WHERE spawn_id = s.id) AS last_event_at
       FROM v3_spawns s
       LEFT JOIN v3_nodes n ON n.id = s.node_id
       LEFT JOIN v3_runs  r ON r.id = n.run_id
      WHERE s.status = 'running'`,
  );

  for (const row of runningCandidates.rows as Array<Record<string, unknown>>) {
    const id = String(row.id);
    const nodeId = row.node_id == null ? null : String(row.node_id);
    const runId = row.run_id == null ? null : String(row.run_id);
    const runtime = row.runtime == null ? null : String(row.runtime);
    const vmName = row.vm_name == null ? null : String(row.vm_name);
    const nodeStatus = row.node_status == null ? null : String(row.node_status);
    const runStatus = row.run_status == null ? null : String(row.run_status);
    const startedAt = row.started_at
      ? new Date(String(row.started_at)).getTime()
      : 0;
    // Heartbeat = the spawn's most recent v3_events row; fall back to
    // started_at when no event has landed yet (still a valid "last known
    // alive" signal for a spawn that just opened).
    const lastEventAt = row.last_event_at
      ? new Date(String(row.last_event_at)).getTime()
      : startedAt;

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
    //   (3) its own event stream has gone silent past the stall threshold
    //       (catches a dead microVM/network black-hole regardless of
    //       runtime/vm_name — the R9 "运行期判活" signal), OR
    //   (4) older than the hard stale backstop regardless.
    const parentTerminal = nodeTerminal || runTerminal;
    const noVmAndAged = !liveVm && startedAt < Date.now() - noVmGraceMs;
    const eventStalled = !parentTerminal && Date.now() - lastEventAt > stallMs;
    const hardStale = startedAt < Date.now() - staleGraceMs;
    if (!parentTerminal && !noVmAndAged && !eventStalled && !hardStale)
      continue;

    const ageMin = Math.round((Date.now() - startedAt) / 60_000);
    const silentMin = Math.round((Date.now() - lastEventAt) / 60_000);
    const why = parentTerminal
      ? `parent ${nodeTerminal ? `node ${nodeStatus}` : `run ${runStatus}`}`
      : noVmAndAged
        ? `no live microVM (runtime=${runtime ?? "?"}) for ~${ageMin}m`
        : eventStalled
          ? `no v3_events heartbeat for ~${silentMin}m (stall)`
          : `stale running spawn (~${ageMin}m)`;
    const reason = `reconciled: stranded running spawn — ${why}`;

    // Guard the write on status='running' so we never race a spawn that just
    // settled. Settle as 'failed' (it never completed).
    const upd = await getDbExec().execute({
      sql: `UPDATE v3_spawns
          SET status = 'failed',
              error = $2,
              error_class = 'reconciled-stranded',
              completed_at = now()
        WHERE id = $1
          AND status = 'running'
        RETURNING id`,
      args: [
        id,
        `Reset by spawn reconcile: ${why}. The spawn was stranded 'running' ` +
          `(process restart / killed VM / parent taken terminal) with no live ` +
          `worker; cleared so the pool reflects reality.`,
      ],
    });
    if ((upd.rows?.length ?? 0) > 0) {
      if (nodeId && nodeTerminal) {
        // Node already resolved — nothing left to migrate. Clear the
        // dangling pointer so the Pool page stops showing a phantom link.
        await getDbExec()
          .execute({
            sql: `UPDATE v3_nodes SET current_spawn_id = NULL
            WHERE id = $1 AND current_spawn_id = $2`,
            args: [nodeId, id],
          })
          .catch(() => {});
      } else if (nodeId && !nodeTerminal && runId) {
        // R9 gap: leave current_spawn_id pointing at this now-failed spawn —
        // the reconciler's conduction rule reads it on its next tick.
        runsToRetick.add(runId);
      }
      reconciled.push({ id, from: "running", to: "failed", reason });
    }
  }

  // Ask the reconciler to look again for every run with a conduction-gap
  // node — triggerTickSafe never throws (best-effort) and is idempotent.
  for (const runId of runsToRetick) {
    await triggerTickSafe(runId);
  }

  // ── (B) Orphaned PENDING spawns ──────────────────────────────────────────
  // A pending spawn never bound to a node (node_id IS NULL) and older than the
  // hard grace is a created-but-never-dispatched orphan from a killed test. A
  // bound or recent pending spawn is a real queued dispatch — left alone.
  const pendingOrphans = await getDbExec().execute({
    sql: `SELECT s.id AS id,
            COALESCE(s.started_at, 'epoch'::timestamptz) AS started_at
       FROM v3_spawns s
      WHERE s.status = 'pending'
        AND s.node_id IS NULL
        AND COALESCE(s.started_at, 'epoch'::timestamptz) < $1`,
    args: [staleCutoffIso],
  });

  for (const row of pendingOrphans.rows as Array<Record<string, unknown>>) {
    const id = String(row.id);
    const startedAt = row.started_at
      ? new Date(String(row.started_at)).getTime()
      : 0;
    const ageMin = Math.round((Date.now() - startedAt) / 60_000);
    const reason = `reconciled: orphaned pending spawn (no node, ~${ageMin}m)`;
    const upd = await getDbExec().execute({
      sql: `UPDATE v3_spawns
          SET status = 'cancelled',
              error = $2,
              error_class = 'reconciled-orphan',
              completed_at = now()
        WHERE id = $1
          AND status = 'pending'
          AND node_id IS NULL
        RETURNING id`,
      args: [
        id,
        `Reset by spawn reconcile: pending spawn never bound to a node ` +
          `(orphan from a killed/aborted dispatch); cancelled so the pool ` +
          `queue reflects reality.`,
      ],
    });
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
