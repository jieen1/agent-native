import { getDbExec, intType, isPostgres } from "../db/client.js";

/**
 * event_log — additive, core-owned durable sink for emitted bus events.
 *
 * Phase A3 (§1.5.23) cross-process event bridge. Every `emit()` appends one
 * row here AFTER in-process dispatch (best-effort, swallowed — never blocks or
 * breaks the synchronous dispatch path). A sibling app's event-bridge poller
 * pulls new rows over HTTP (`GET /_agent-native/event-log?since=&names=`),
 * advancing a monotonic cursor (`seq`) so each event is delivered exactly once
 * and a restart resumes from the last cursor.
 *
 * The table is created lazily with the same `ensureTable` pattern as
 * `routine-runs/store.ts`: a module-level `_initPromise` runs the
 * `CREATE TABLE IF NOT EXISTS` once and resets on failure so a transient DB
 * error can retry.
 *
 * Dialect note: unlike `routine_runs` (a caller-generated TEXT uuid id), this
 * table needs an auto-incrementing `seq` for the cursor. The lazy `ensureTable`
 * path issues raw DDL through `getDbExec().execute(...)` directly — it does NOT
 * pass through `runMigrations`' `adaptSqlForPostgres` (which strips
 * `AUTOINCREMENT` and rewrites `INTEGER`→`BIGINT`). So the seq column is
 * branched per dialect here: SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`,
 * Postgres `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`.
 */

let _initPromise: Promise<void> | undefined;

function seqColumnDdl(): string {
  return isPostgres()
    ? "seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
    : "seq INTEGER PRIMARY KEY AUTOINCREMENT";
}

async function ensureTable(): Promise<void> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const client = getDbExec();
      await client.execute(`
        CREATE TABLE IF NOT EXISTS event_log (
          ${seqColumnDdl()},
          id TEXT NOT NULL,
          owner_email TEXT,
          org_id TEXT,
          name TEXT NOT NULL,
          payload_json TEXT,
          emitted_at ${intType()} NOT NULL
        )
      `);
      // Read-path hot indexes for the poller's owner-scoped, name-filtered,
      // `seq > since` range scan. Both are dialect-agnostic (no DESC/partial/
      // PG-only syntax) and idempotent via IF NOT EXISTS.
      for (const ddl of [
        `CREATE INDEX IF NOT EXISTS event_log_seq_idx ON event_log (seq)`,
        `CREATE INDEX IF NOT EXISTS event_log_owner_name_idx ON event_log (owner_email, name, seq)`,
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

export interface AppendEventLogInput {
  /** = EventMeta.eventId — carried for cross-process dedup if ever needed. */
  id: string;
  /** Dotted event name, e.g. "plan.created". */
  name: string;
  /** Owner/user email the event is scoped to (from EventMeta.owner). */
  ownerEmail?: string;
  orgId?: string;
  /** Pre-serialized payload (caller JSON.stringifies; "null" on failure). */
  payloadJson: string;
  /** Epoch milliseconds. */
  emittedAt: number;
}

/**
 * Append one row to event_log.
 *
 * Best-effort: failures are swallowed so the durable sink can never break the
 * synchronous `emit()` dispatch path. On a fresh database with no DB configured
 * (pure unit tests), `getDbExec()` throws and is swallowed here.
 */
export async function appendEventLog(
  input: AppendEventLogInput,
): Promise<void> {
  try {
    await ensureTable();
    const client = getDbExec();
    await client.execute({
      sql: `INSERT INTO event_log (id, owner_email, org_id, name, payload_json, emitted_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.ownerEmail ?? null,
        input.orgId ?? null,
        input.name,
        input.payloadJson,
        input.emittedAt,
      ],
    });
  } catch (err) {
    console.error(
      "[event-log] appendEventLog failed (event not recorded):",
      err instanceof Error ? err.message : err,
    );
  }
}

export interface EventLogEntry {
  seq: number;
  name: string;
  payload: unknown;
  emittedAt: number;
}

export interface ReadEventLogResult {
  events: EventLogEntry[];
  cursor: number;
}

export interface ReadEventLogOptions {
  /** Return rows with `seq > since`. */
  since: number;
  /** When non-empty, restrict to these event names. */
  names?: string[];
  /** Max rows to return (clamped 1..500, default 200). */
  limit?: number;
}

/**
 * Owner-scoped read of event_log rows with `seq > since`, oldest first.
 *
 * Owner scope is strict: `owner_email = ?`. Rows with a NULL owner are not
 * matched by any authenticated user — no-owner events never leak across the
 * bridge (security default; Phase A3 acceptance "A's JWT only pulls A's
 * events"). Returns `cursor` = the max seq in this page, or `since` when empty.
 */
export async function readEventLog(
  ownerEmail: string,
  opts: ReadEventLogOptions,
): Promise<ReadEventLogResult> {
  try {
    await ensureTable();
    const client = getDbExec();
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 200), 1), 500);
    const args: unknown[] = [ownerEmail, opts.since];
    let sql = `SELECT seq, name, payload_json, emitted_at
      FROM event_log WHERE owner_email = ? AND seq > ?`;
    const names = (opts.names ?? []).filter((n) => typeof n === "string" && n);
    if (names.length > 0) {
      sql += ` AND name IN (${names.map(() => "?").join(", ")})`;
      args.push(...names);
    }
    sql += ` ORDER BY seq ASC LIMIT ?`;
    args.push(limit);

    const { rows } = await client.execute({ sql, args });
    const events: EventLogEntry[] = rows.map((row) => {
      let payload: unknown = null;
      const raw = row.payload_json as string | null;
      if (raw != null) {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = null;
        }
      }
      return {
        seq: Number(row.seq),
        name: row.name as string,
        payload,
        emittedAt: Number(row.emitted_at),
      };
    });
    const cursor =
      events.length > 0 ? events[events.length - 1].seq : opts.since;
    return { events, cursor };
  } catch {
    // Table may not exist yet on a fresh database — treat as no events.
    return { events: [], cursor: opts.since };
  }
}
