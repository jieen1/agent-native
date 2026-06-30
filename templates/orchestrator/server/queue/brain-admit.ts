// LEVEL-1 brain-task admission gate (the concurrency limiter).
//
// Every brain dispatch inserts a `brain_tasks` row `queued` (see actions/
// brain-send.ts). This module promotes queued tasks to `running` up to the
// configured degree and starts the brain child ONLY for the promoted ones. The
// rest stay queued until a slot frees (released on run-terminal by the
// reconciler, or by the reaper).
//
// Concurrency safety: the count→promote critical section is serialized by a
// Postgres advisory lock (the same primitive the reconciler uses), so concurrent
// callers — N parallel brain-send admits + the driver tick — can never
// over-admit past `degree`. Each promotion is ALSO a guarded UPDATE
// (status='queued' re-asserted), so even without the lock two racers resolve to
// one winner per row (no double-start). The lock makes the GLOBAL count honest.
//
// Slot accounting: a task occupies one slot from admission (status='running')
// until it is released to a terminal status (done/failed/cancelled). Release is
// NOT keyed on the brain thread's status (that flips on every wake) — it is
// driven by the bound run reaching terminal (releaseBrainTaskForThread, called
// from the reconciler) or the reaper.

import { v3DbExec, isV3PostgresConfigured, getV3PgClient } from "../db/v3.js";
import { newId } from "../../actions/_util.js";
import { getBrainConcurrency } from "./brain-concurrency.js";

/** Advisory-lock key for the brain admission critical section (arbitrary const). */
const BRAIN_ADMIT_LOCK_KEY = 918_273_645;

/** A queued brain_tasks row the gate is about to promote. */
interface QueuedTask {
  id: string;
  threadId: string;
  message: string | null;
  repo: string | null;
  baseBranch: string | null;
  workspaceId: string | null;
  tags: Record<string, unknown> | null;
  ownerEmail: string;
  orgId: string | null;
}

/** Count brain_tasks currently occupying a slot (status='running'). */
export async function countRunningBrainTasks(): Promise<number> {
  const res = await v3DbExec(
    `SELECT count(*)::int AS n FROM brain_tasks WHERE status = 'running'`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** Count queued brain_tasks (waiting for a slot). */
export async function countQueuedBrainTasks(): Promise<number> {
  const res = await v3DbExec(
    `SELECT count(*)::int AS n FROM brain_tasks WHERE status = 'queued'`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Insert a brain_tasks row in `queued` state. Returns the task id and the live
 * queue position (1-based among queued, by priority then created_at) so the
 * caller can report where the dispatch landed.
 */
export async function enqueueBrainTask(input: {
  threadId: string;
  message: string;
  repo?: string | null;
  baseBranch?: string | null;
  workspaceId?: string | null;
  tags?: Record<string, unknown> | null;
  ownerEmail: string;
  orgId?: string | null;
  priority?: number;
}): Promise<{ taskId: string; queuePosition: number }> {
  const taskId = newId("btask");
  await v3DbExec(
    `INSERT INTO brain_tasks
       (id, thread_id, status, message, repo, base_branch, workspace_id, tags,
        owner_email, org_id, priority, created_at, updated_at)
     VALUES ($1,$2,'queued',$3,$4,$5,$6,$7,$8,$9,$10, now(), now())`,
    [
      taskId,
      input.threadId,
      input.message,
      input.repo ?? null,
      input.baseBranch ?? null,
      input.workspaceId ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.ownerEmail,
      input.orgId ?? null,
      input.priority ?? 0,
    ],
  );

  // Live queue position among queued tasks (1-based by priority, created_at).
  const posRes = await v3DbExec(
    `SELECT count(*)::int AS n FROM brain_tasks
      WHERE status = 'queued'
        AND (priority < (SELECT priority FROM brain_tasks WHERE id = $1)
             OR (priority = (SELECT priority FROM brain_tasks WHERE id = $1)
                 AND created_at <= (SELECT created_at FROM brain_tasks WHERE id = $1)))`,
    [taskId],
  );
  const queuePosition = Number(posRes.rows[0]?.n ?? 1);
  return { taskId, queuePosition };
}

/**
 * Promote queued brain tasks to `running` up to the configured degree and start
 * the brain child for each promoted task. Idempotent and safe to call from
 * multiple paths concurrently (advisory-locked + guarded per-row promotion).
 *
 * Returns the ids of tasks promoted (and started) this call.
 */
export async function admitBrainTasks(): Promise<string[]> {
  if (!isV3PostgresConfigured()) return [];
  const pg = getV3PgClient();
  if (!pg) return [];

  // ── Phase 1: claim slots under a TRANSACTION-SCOPED advisory lock ──────────
  // The slot accounting (count running → pick queued candidates → guarded
  // promote to 'running') runs inside ONE transaction on ONE connection. We use
  // pg_advisory_xact_lock (NOT the session-scoped pg_try_advisory_lock): the
  // session lock is a foot-gun on a POOLED client because the LOCK and UNLOCK
  // can land on different pooled connections — the unlock then errors with
  // "you don't own a lock" AND the lock leaks forever, wedging all future
  // admits. The xact lock is held by the transaction and auto-released on
  // commit/rollback, on the SAME connection — no manual unlock, no leak, no
  // cross-connection mismatch. Blocking (not try): contention here is brief
  // (a few UPDATEs), and a concurrent admit should WAIT and then see the
  // updated running-count rather than silently bail and strand a queued task.
  //
  // The brain children (clone + spawn `claude -p`) are LONG-running, so they are
  // started in Phase 2 AFTER the transaction commits — the lock is never held
  // across a clone/spawn.
  let claimed: QueuedTask[] = [];
  try {
    claimed = await pg.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${BRAIN_ADMIT_LOCK_KEY})`;

      const degree = await getBrainConcurrency();
      const runningRes =
        await tx`SELECT count(*)::int AS n FROM brain_tasks WHERE status = 'running'`;
      const running = Number(runningRes[0]?.n ?? 0);
      const slots = degree - running;
      if (slots <= 0) return [];

      // Atomically promote up to `slots` queued tasks to 'running' in ONE
      // statement (priority then oldest), returning the promoted rows. A single
      // guarded UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n)
      // is race-free under the xact lock and avoids a per-row round-trip.
      const promotedRows = await tx`
        UPDATE brain_tasks
           SET status = 'running', claimed_at = now(), updated_at = now()
         WHERE id IN (
           SELECT id FROM brain_tasks
            WHERE status = 'queued'
            ORDER BY priority ASC, created_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${slots}
         )
        RETURNING id, thread_id, message, repo, base_branch, workspace_id, tags,
                  owner_email, org_id`;

      return (promotedRows as unknown as Array<Record<string, unknown>>).map(
        (r) => ({
          id: String(r.id),
          threadId: String(r.thread_id),
          message: (r.message as string | null) ?? null,
          repo: (r.repo as string | null) ?? null,
          baseBranch: (r.base_branch as string | null) ?? null,
          workspaceId: (r.workspace_id as string | null) ?? null,
          tags: (r.tags as Record<string, unknown> | null) ?? null,
          ownerEmail: String(r.owner_email ?? "local@localhost"),
          orgId: (r.org_id as string | null) ?? null,
        }),
      );
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[brain-admit] claim transaction failed: ${msg}`);
    return [];
  }

  // ── Phase 2: start the brain child for each claimed task (OUTSIDE the lock) ──
  // The rows are already 'running' (slot reserved). Provisioning + spawning the
  // brain happens here without holding the DB lock. On failure, release the slot
  // by marking the task 'failed' so it does not hold a slot forever.
  const promoted: string[] = [];
  for (const task of claimed) {
    try {
      const provisioned = await startBrainTaskTurn(task);
      if (
        provisioned.workspaceId &&
        provisioned.workspaceId !== task.workspaceId
      ) {
        await v3DbExec(
          `UPDATE brain_tasks SET workspace_id = $2, updated_at = now() WHERE id = $1`,
          [task.id, provisioned.workspaceId],
        );
      }
      promoted.push(task.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[brain-admit] start failed for task ${task.id}: ${msg}`);
      await v3DbExec(
        `UPDATE brain_tasks SET status = 'failed', updated_at = now() WHERE id = $1`,
        [task.id],
      ).catch(() => {});
    }
  }

  return promoted;
}

/**
 * Provision the task's workspace (when a repo was given and none was bound yet)
 * and start the brain turn. Mirrors the original brain-send body, run lazily at
 * admission time instead of at dispatch time. Returns the resolved workspace id.
 *
 * Dynamically imports the workspace + brain-session modules so this queue module
 * has no static dependency cycle with the brain layer.
 */
async function startBrainTaskTurn(
  task: QueuedTask,
): Promise<{ workspaceId: string | null }> {
  let workspaceId = task.workspaceId;

  if (!workspaceId && task.repo && task.repo.trim()) {
    const { createLocalWorkspace } = await import("../v3-workspace-local.js");
    // Do NOT pass `baseBranch` as the worktree `branch`: that would try to check
    // out the base branch (e.g. `main`) itself, which fails under concurrency
    // with "fatal: 'main' is already checked out" once another worktree holds
    // it. Let `branch` default to the per-run branch (`orchestrator/run-<id>`),
    // which provisionWorktree cuts fresh from the mirror's base ref (origin/HEAD
    // → main). Each running task thus gets its own isolated branch + worktree.
    const ws = await createLocalWorkspace({
      repoUrl: task.repo.trim(),
      // Cut the fresh run branch FROM the project's default branch (the base
      // ref), not check it out — so it never collides under concurrency.
      baseRef: task.baseBranch?.trim() || undefined,
      ownerKind: "user",
      ownerId: task.ownerEmail,
      createdBy: task.ownerEmail,
    });
    workspaceId = ws.id;
  }

  const { startBrainTurn } = await import("../brain/brain-session.js");
  await startBrainTurn({
    threadId: task.threadId,
    ownerEmail: task.ownerEmail,
    orgId: task.orgId ?? null,
    message: task.message ?? "",
    workspaceId: workspaceId ?? undefined,
  });

  return { workspaceId: workspaceId ?? null };
}

/**
 * Release the slot held by the RUNNING brain task(s) bound to a brain thread,
 * marking them terminal. Called from the reconciler on run-terminal (anchored to
 * the bound run going terminal, NOT to thread idle — the thread status flips on
 * every wake). Then pulls the next queued task via admitBrainTasks().
 *
 * `status` is the terminal disposition of the bound run (done/failed/cancelled);
 * a cancelled run releases as 'cancelled', anything else as 'done'. Guarded on
 * status='running' so a re-reconcile of the same terminal run is a no-op.
 *
 * Returns the number of tasks released (0 when none were running for the thread).
 */
export async function releaseBrainTaskForThread(
  threadId: string,
  runStatus: "done" | "failed" | "cancelled" = "done",
): Promise<number> {
  if (!isV3PostgresConfigured()) return 0;
  const terminal = runStatus === "cancelled" ? "cancelled" : "done";
  const upd = await v3DbExec(
    `UPDATE brain_tasks
        SET status = $2, updated_at = now()
      WHERE thread_id = $1 AND status = 'running'
    RETURNING id`,
    [threadId, terminal],
  );
  const released = upd.rows?.length ?? 0;
  if (released > 0) {
    // Pull the next queued task(s) into the freed slot(s).
    await admitBrainTasks().catch(() => {});
  }
  return released;
}
