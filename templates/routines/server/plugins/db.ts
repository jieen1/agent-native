// guard:allow-unscoped -- schema migrations run system-wide at startup, not in a user-scoped request path.
import { runMigrations } from "@agent-native/core/db";

/**
 * Routines app migrations.
 *
 * The Routines app stores routine definitions as `jobs/*.md` resources, so it
 * owns no routine table. The one table it READS is `routine_runs`, the
 * additive run-history table owned by `@agent-native/core/routine-runs`. Core
 * creates that table lazily on its first write (scheduler / dispatcher hook),
 * but the app's read path (`list-routine-runs`) can run before any routine has
 * ever executed. To keep reads from racing a not-yet-created table, we mirror
 * the exact same `CREATE TABLE IF NOT EXISTS` here.
 *
 * This is safe and additive:
 *  - `IF NOT EXISTS` makes it idempotent and a no-op once core has created it
 *    (and vice-versa) — the two creators never conflict.
 *  - The column set is identical to core's DDL in
 *    `packages/core/src/routine-runs/store.ts`. `INTEGER` is rewritten to
 *    `BIGINT` on Postgres by the migration adapter, matching core's `intType()`.
 *
 * Version 2 (additive) adds `event_cursors` for the Phase A3 cross-process
 * event bridge (§1.5.23): one row per (source_app, owner_email) holding the
 * last `event_log.seq` the bridge poller pulled, so restarts resume from the
 * persisted cursor and each event is processed exactly once. `INTEGER` is
 * rewritten to `BIGINT` on Postgres by the migration adapter.
 */
export default runMigrations(
  [
    {
      version: 1,
      sql: `CREATE TABLE IF NOT EXISTS routine_runs (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL DEFAULT 'local@localhost',
        org_id TEXT,
        routine_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        trigger TEXT,
        thread_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS routine_runs_owner_started_idx ON routine_runs (owner_email, started_at);
      CREATE INDEX IF NOT EXISTS routine_runs_name_started_idx ON routine_runs (routine_name, started_at);`,
    },
    {
      version: 2,
      sql: `CREATE TABLE IF NOT EXISTS event_cursors (
        source_app TEXT NOT NULL,
        owner_email TEXT NOT NULL DEFAULT 'local@localhost',
        cursor INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_app, owner_email)
      );`,
    },
  ],
  { table: "routines_migrations" },
);
