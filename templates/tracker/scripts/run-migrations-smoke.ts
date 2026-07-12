/**
 * Runnable migration smoke (referenced by the it.skip in
 * server/plugins/__tests__/db-migration.test.ts).
 *
 * Applies the REAL migration file (server/plugins/db.ts) against whatever
 * DATABASE_URL points at, then proves the newest additive columns exist by
 * SELECTing them (a missing column throws). This is the reproducible artifact
 * the deferred real-Postgres check runs in the deployment window — per the B5
 * lesson that a SQLite in-memory pass is NOT migration-application evidence.
 *
 * Dialect-agnostic via core's getDbExec (no direct pg/libsql dependency), so
 * the same script proves the columns on a one-time empty Postgres OR a
 * throwaway SQLite file.
 *
 * Usage (from templates/tracker/):
 *   # real empty Postgres (the deployment-window evidence run):
 *   DATABASE_URL=postgres://user:pass@host:5432/throwaway_db \
 *     pnpm exec tsx scripts/run-migrations-smoke.ts
 *   # throwaway SQLite file (quick local sanity of the script itself):
 *   DATABASE_URL=file:/tmp/tracker-smoke.db \
 *     pnpm exec tsx scripts/run-migrations-smoke.ts
 */
import { getDbExec, closeDbExec } from "@agent-native/core/db";

const REQUIRED_COLUMNS = [
  "scale_estimate", // v25 (F5 任务拆分阈值)
  "split_parent_id", // v25 (F5)
  "exec_state", // v24 (F3) — sanity anchor that earlier migrations applied too
] as const;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set DATABASE_URL to a THROWAWAY empty database first (never a real/prod DB)",
    );
  }

  // Apply v1..vN via the REAL migration runner (server/plugins/db.ts).
  const runMigrations = (await import("../server/plugins/db.js"))
    .default as unknown as () => Promise<void>;
  await runMigrations();

  // A missing column makes this SELECT throw — dialect-agnostic existence proof
  // (works on both Postgres and SQLite; no information_schema branch needed).
  const exec = getDbExec();
  await exec.execute(
    `SELECT ${REQUIRED_COLUMNS.join(", ")} FROM tracker_work_items LIMIT 0`,
  );

  const dialect = url.split("://")[0] || url.slice(0, 8);
  console.log(
    `PASS: migration smoke on ${dialect} — columns present: ${REQUIRED_COLUMNS.join(", ")}`,
  );
  await closeDbExec?.();
}

main().catch((err) => {
  console.error("FAIL: migration smoke —", err?.message ?? err);
  process.exit(1);
});
