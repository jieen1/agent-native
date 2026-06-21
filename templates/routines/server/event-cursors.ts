/**
 * event_cursors read/write — the Routines side of the Phase A3 cross-process
 * event bridge (§1.5.23).
 *
 * One row per (source_app, owner_email) holds the last `event_log.seq` the
 * bridge poller pulled from that sibling app for that owner. The composite
 * primary key `(source_app, owner_email)` is created by the version-2 migration
 * in `server/plugins/db.ts`. Reads default to 0 (resume from the start);
 * writes upsert with a dialect-aware ON CONFLICT so a restart resumes from the
 * persisted cursor and each event is processed exactly once.
 */

import { getDbExec } from "@agent-native/core/db";

/**
 * Read the persisted cursor for (sourceApp, ownerEmail). Returns 0 when no row
 * exists yet (fresh source) or the table is not ready.
 */
export async function getEventCursor(
  sourceApp: string,
  ownerEmail: string,
): Promise<number> {
  try {
    const client = getDbExec();
    const { rows } = await client.execute({
      sql: `SELECT cursor FROM event_cursors WHERE source_app = ? AND owner_email = ?`,
      args: [sourceApp, ownerEmail],
    });
    if (!rows || rows.length === 0) return 0;
    const value = Number((rows[0] as { cursor: unknown }).cursor);
    return Number.isFinite(value) ? value : 0;
  } catch {
    // Table may not exist yet — treat as no cursor (resume from start).
    return 0;
  }
}

/**
 * Upsert the cursor for (sourceApp, ownerEmail). Monotonic: never moves the
 * stored cursor backwards (guards against an out-of-order or duplicate poll
 * pass). Best-effort: failures are swallowed so a transient DB error can never
 * break the poll loop — the next pass re-reads and re-advances.
 */
export async function setEventCursor(
  sourceApp: string,
  ownerEmail: string,
  cursor: number,
): Promise<void> {
  try {
    const client = getDbExec();
    // Monotonic upsert. `?` placeholders are auto-rewritten to `$1..` on
    // Postgres by the core db client; both SQLite and Postgres support
    // `ON CONFLICT (...) DO UPDATE ... WHERE excluded.cursor > event_cursors.cursor`,
    // which guards against moving the persisted cursor backwards.
    await client.execute({
      sql: `INSERT INTO event_cursors (source_app, owner_email, cursor)
        VALUES (?, ?, ?)
        ON CONFLICT (source_app, owner_email)
        DO UPDATE SET cursor = excluded.cursor
        WHERE excluded.cursor > event_cursors.cursor`,
      args: [sourceApp, ownerEmail, cursor],
    });
  } catch (err) {
    console.error(
      "[event-cursors] setEventCursor failed (cursor not persisted):",
      err instanceof Error ? err.message : err,
    );
  }
}
