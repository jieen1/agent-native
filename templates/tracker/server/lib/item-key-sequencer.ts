// F8: itemKey allocation authority — the single project-level sequencer.
//
// Replaces the pre-F8 `count(*) + 1` allocation that used to live inline in
// create-work-item.ts AND decompose-epic.ts (two independent, uncoordinated
// writers racing on the same `SELECT count(*)` — SDLC-038: concurrent
// create-work-item calls for the same project minted duplicate itemKeys).
// Both call sites now route through `allocateItemKey()` here, so there is
// exactly one place that hands out a project's next number.
//
// Backed by `tracker_project_seq` (project_id PRIMARY KEY, next_seq NOT
// NULL). `next_seq` holds the LAST issued number, not the next one — the
// Postgres path's `UPDATE ... SET next_seq = next_seq + 1 RETURNING
// next_seq` pre-increments and returns the freshly allocated number in the
// same round trip, so 20 concurrent callers against the same project_id each
// get a unique, contiguous number: Postgres row-level locking on the UPDATE
// serializes them. This atomicity claim (T-F8-01) is proven against a REAL
// Postgres by the committed script scripts/f8-pg-verify.mts (PHASE 3), not by
// the SQLite unit suite — SQLite/libsql's single-writer lock would silently
// serialize "concurrent" calls and hide a real race, so it cannot stand in as
// proof here.
import { getDbExec, isPostgres } from "@agent-native/core/db";

const NUMERIC_SUFFIX_RE = /(\d+)\s*$/;

/** Extract the highest trailing-numeric-suffix value across a batch of
 *  itemKey strings (e.g. "PAY-014" -> 14). Used for the SQLite/libsql lazy
 *  seed path, where the Postgres-only regex-substring extraction used by the
 *  v27 migration backfill isn't available. Unparseable / blank keys are
 *  ignored (contribute 0), matching the migration's COALESCE(..., 0). */
export function maxNumericSuffix(
  itemKeys: Array<string | null | undefined>,
): number {
  let max = 0;
  for (const key of itemKeys) {
    const m = NUMERIC_SUFFIX_RE.exec(String(key ?? ""));
    if (!m) continue;
    const n = parseInt(m[1]!, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Atomically allocate the next itemKey for a project (e.g. "PAY-015").
 *
 * Lazy per-project init: a project without a `tracker_project_seq` row yet —
 * either created after the v27 migration ran, or running under SQLite/libsql
 * (where the migration's Postgres-only backfill is a no-op) — is seeded here
 * on first call, from the same "current max itemKey number" computation the
 * migration uses. `ON CONFLICT (project_id) DO NOTHING` (Postgres) / `INSERT
 * OR IGNORE` (SQLite) makes this race-safe: if a concurrent caller already
 * seeded (or is mid-seeding) the row, this caller's seed attempt is a no-op
 * and it proceeds straight to the atomic increment.
 */
export async function allocateItemKey(
  projectId: string,
  projectKey: string,
): Promise<string> {
  const exec = getDbExec();

  if (isPostgres()) {
    await exec.execute({
      sql: `INSERT INTO tracker_project_seq (project_id, next_seq)
            SELECT ?, COALESCE(MAX(CAST(NULLIF(substring(item_key from '[0-9]+$'), '') AS INTEGER)), 0)
            FROM tracker_work_items WHERE project_id = ?
            ON CONFLICT (project_id) DO NOTHING`,
      args: [projectId, projectId],
    });
    const { rows } = await exec.execute({
      sql: `UPDATE tracker_project_seq SET next_seq = next_seq + 1 WHERE project_id = ? RETURNING next_seq`,
      args: [projectId],
    });
    const seq = Number((rows[0] as { next_seq: number } | undefined)?.next_seq);
    return `${projectKey}-${String(seq).padStart(3, "0")}`;
  }

  // SQLite/libsql (local dev + unit tests). No claim of correctness under
  // real concurrent connections is made here (see module doc) — this exists
  // so dev/test runs (single connection) get correct, non-repeating numbers.
  const seedRow = await exec.execute({
    sql: `SELECT next_seq FROM tracker_project_seq WHERE project_id = ?`,
    args: [projectId],
  });
  if (seedRow.rows.length === 0) {
    const items = await exec.execute({
      sql: `SELECT item_key FROM tracker_work_items WHERE project_id = ?`,
      args: [projectId],
    });
    const seed = maxNumericSuffix(
      (items.rows as Array<{ item_key?: string | null }>).map(
        (r) => r.item_key,
      ),
    );
    await exec.execute({
      sql: `INSERT OR IGNORE INTO tracker_project_seq (project_id, next_seq) VALUES (?, ?)`,
      args: [projectId, seed],
    });
  }
  await exec.execute({
    sql: `UPDATE tracker_project_seq SET next_seq = next_seq + 1 WHERE project_id = ?`,
    args: [projectId],
  });
  const { rows } = await exec.execute({
    sql: `SELECT next_seq FROM tracker_project_seq WHERE project_id = ?`,
    args: [projectId],
  });
  const seq = Number((rows[0] as { next_seq: number } | undefined)?.next_seq);
  return `${projectKey}-${String(seq).padStart(3, "0")}`;
}
