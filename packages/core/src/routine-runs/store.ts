import { randomUUID } from "node:crypto";
import { getDbExec, intType } from "../db/client.js";

/**
 * routine_runs — additive, core-owned history table for routine executions.
 *
 * Each row records one real run of a routine (schedule-type via the job
 * scheduler, or event-type via the trigger dispatcher). It is written by the
 * engine hooks in `jobs/scheduler.ts` and `triggers/dispatcher.ts` and read
 * (owner-scoped) by the routines app. The table is read-only history, so it
 * carries only the two ownable columns (`owner_email`, `org_id`) and no
 * sharing/visibility plumbing.
 *
 * The table is created lazily with the same `ensureTable` pattern as
 * `application-state/store.ts` and `chat-threads/store.ts`: a module-level
 * `_initPromise` runs `CREATE TABLE IF NOT EXISTS` once. The id is a
 * caller-generated TEXT uuid (mirrors `chat_threads.id TEXT`) to avoid the
 * SQLite/Postgres autoincrement dialect split.
 */

export type RoutineRunKind = "schedule" | "event";
export type RoutineRunStatus = "running" | "success" | "error" | "skipped";

let _initPromise: Promise<void> | undefined;

async function ensureTable(): Promise<void> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const client = getDbExec();
      await client.execute(`
        CREATE TABLE IF NOT EXISTS routine_runs (
          id TEXT PRIMARY KEY,
          owner_email TEXT NOT NULL DEFAULT 'local@localhost',
          org_id TEXT,
          routine_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          trigger TEXT,
          thread_id TEXT,
          status TEXT NOT NULL,
          error TEXT,
          started_at ${intType()} NOT NULL,
          finished_at ${intType()}
        )
      `);
      // Hot read paths for the routines app history view: the owner-scoped
      // recent-runs list (owner_email + started_at) and the per-routine
      // history list (routine_name + started_at). Both are dialect-agnostic
      // (no DESC/partial/PG-only syntax) so they apply identically on SQLite
      // and Postgres. `IF NOT EXISTS` makes them idempotent across restarts.
      for (const ddl of [
        `CREATE INDEX IF NOT EXISTS routine_runs_owner_started_idx ON routine_runs (owner_email, started_at)`,
        `CREATE INDEX IF NOT EXISTS routine_runs_name_started_idx ON routine_runs (routine_name, started_at)`,
      ]) {
        try {
          await client.execute(ddl);
        } catch {
          // Index already exists or the dialect rejected a duplicate.
        }
      }
    })().catch((err) => {
      // Retry init on the next call after a failed startup.
      _initPromise = undefined;
      throw err;
    });
  }
  return _initPromise;
}

export interface InsertRoutineRunInput {
  ownerEmail: string;
  orgId?: string;
  routineName: string;
  kind: RoutineRunKind;
  trigger?: string;
  threadId?: string;
  status: "running";
  startedAt: number;
}

/**
 * Inserts a `running` row at the start of a routine run and returns its id.
 *
 * Best-effort: failures are swallowed so that history bookkeeping can never
 * break the existing job/trigger state machine. On failure the returned id is
 * still a valid uuid; the matching `finishRoutineRun` update will simply no-op.
 */
export async function insertRoutineRun(
  input: InsertRoutineRunInput,
): Promise<string> {
  const id = randomUUID();
  try {
    await ensureTable();
    const client = getDbExec();
    await client.execute({
      sql: `INSERT INTO routine_runs
        (id, owner_email, org_id, routine_name, kind, trigger, thread_id, status, error, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.ownerEmail,
        input.orgId ?? null,
        input.routineName,
        input.kind,
        input.trigger ?? null,
        input.threadId ?? null,
        input.status,
        null,
        input.startedAt,
        null,
      ],
    });
  } catch (err) {
    console.error(
      "[routine-runs] insertRoutineRun failed (history not recorded):",
      err instanceof Error ? err.message : err,
    );
  }
  return id;
}

export interface FinishRoutineRunPatch {
  status: "success" | "error" | "skipped";
  error?: string;
  finishedAt: number;
}

/**
 * Updates a routine_runs row to its terminal status (+ finishedAt / error).
 *
 * Best-effort: failures are swallowed so that history bookkeeping can never
 * break the existing job/trigger state machine.
 */
export async function finishRoutineRun(
  id: string,
  patch: FinishRoutineRunPatch,
): Promise<void> {
  try {
    await ensureTable();
    const client = getDbExec();
    await client.execute({
      sql: `UPDATE routine_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?`,
      args: [patch.status, patch.error ?? null, patch.finishedAt, id],
    });
  } catch (err) {
    console.error(
      "[routine-runs] finishRoutineRun failed (history not recorded):",
      err instanceof Error ? err.message : err,
    );
  }
}

export interface RoutineRunRow {
  id: string;
  ownerEmail: string;
  orgId: string | null;
  routineName: string;
  kind: RoutineRunKind;
  trigger: string | null;
  threadId: string | null;
  status: RoutineRunStatus;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * Owner-scoped read of recent runs, newest first. Optionally narrowed to a
 * single routine name. Returns an empty array when the table does not yet
 * exist (the engine may not have written any run on a fresh database).
 */
export async function listRoutineRuns(
  ownerEmail: string,
  options?: { routineName?: string; limit?: number },
): Promise<RoutineRunRow[]> {
  try {
    await ensureTable();
    const client = getDbExec();
    const limit = options?.limit ?? 100;
    const args: unknown[] = [ownerEmail];
    let sql = `SELECT id, owner_email, org_id, routine_name, kind, trigger, thread_id, status, error, started_at, finished_at
      FROM routine_runs WHERE owner_email = ?`;
    if (options?.routineName) {
      sql += ` AND routine_name = ?`;
      args.push(options.routineName);
    }
    sql += ` ORDER BY started_at DESC LIMIT ?`;
    args.push(limit);
    const { rows } = await client.execute({ sql, args });
    return rows.map((row) => ({
      id: row.id as string,
      ownerEmail: row.owner_email as string,
      orgId: (row.org_id as string | null) ?? null,
      routineName: row.routine_name as string,
      kind: row.kind as RoutineRunKind,
      trigger: (row.trigger as string | null) ?? null,
      threadId: (row.thread_id as string | null) ?? null,
      status: row.status as RoutineRunStatus,
      error: (row.error as string | null) ?? null,
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    }));
  } catch {
    // Table may not exist yet on a fresh database — treat as no history.
    return [];
  }
}
