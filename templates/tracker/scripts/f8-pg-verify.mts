// F8 real-Postgres verification — the out-of-band proof for the two things
// the committed vitest suite CANNOT prove on SQLite/libsql (documented in the
// `it.skip` blocks of server/plugins/__tests__/db-migration.test.ts and the
// header of server/lib/__tests__/item-key-sequencer.test.ts):
//
//   T-F8-01  20-way concurrent allocateItemKey against the SAME project_id,
//            zero duplicate itemKeys, 3 rounds. SQLite's single-writer lock
//            serializes "concurrent" calls trivially and would pass even a
//            broken (non-atomic) allocator — a false-green (the B5 lesson).
//            Only Postgres row-level locking on
//            `UPDATE ... SET next_seq = next_seq + 1 RETURNING next_seq`
//            actually exercises the race, and only real Postgres reads back
//            the RETURNING value through getDbExec().
//
//   T-F8-06  (Postgres tier) the v27 backfill's
//            `substring(item_key from '[0-9]+$')` extraction is Postgres-only
//            regex syntax (dialect-gated to a table-only no-op on SQLite), so
//            "existing project -> next_seq = current max" can only be proven
//            for real against Postgres.
//
// This is a standalone runtime script (calls process.exit), NOT a vitest
// suite — its filename intentionally lacks `.test`/`.spec` so vitest never
// collects it, and it lives under scripts/ which the template tsconfig's
// `include` does not cover (so it is not part of the app typecheck).
//
// Run it against a throwaway Postgres (e.g. a one-off container) — the exact
// mechanism used for this F8 delivery's evidence:
//
//   docker run -d -e POSTGRES_PASSWORD=postgres -p 0:5432 --name f8pg postgres:16
//   PORT=$(docker port f8pg 5432/tcp | head -1 | sed 's/.*://')
//   docker exec f8pg psql -U postgres -c 'CREATE DATABASE f8test'
//   docker exec f8pg psql -U postgres -c 'CREATE DATABASE f8legacy'
//   (cd templates/tracker && npx tsx scripts/f8-pg-verify.mts \
//      "postgres://postgres:postgres@localhost:$PORT/f8test" \
//      "postgres://postgres:postgres@localhost:$PORT/f8legacy")
//   docker rm -f f8pg
//
// Usage: tsx scripts/f8-pg-verify.mts <pg-url-fresh-empty> <pg-url-legacy>
const [freshUrl, legacyUrl] = process.argv.slice(2);
if (!freshUrl || !legacyUrl) {
  throw new Error(
    "usage: tsx scripts/f8-pg-verify.mts <fresh-empty-pg-url> <legacy-pg-url>",
  );
}

function log(...args: unknown[]) {
  console.log("[f8-pg-verify]", ...args);
}

let failures = 0;
function assertTrue(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error("[FAIL]", msg);
  } else {
    console.log("[PASS]", msg);
  }
}

// PHASE 1 — T-F8-06 tier A: run the REAL migration plugin against a fresh
// empty db, assert the two v27 tables + columns exist.
async function phase1() {
  log("=== PHASE 1: empty-db migration (T-F8-06 tier A) ===");
  process.env.DATABASE_URL = freshUrl;
  const mod = await import("../server/plugins/db.js");
  const runMigrations = mod.default as unknown as () => Promise<void>;
  await runMigrations();

  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();

  const tables = await exec.execute(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('tracker_work_item_runs', 'tracker_project_seq')
  `);
  const names = new Set(tables.rows.map((r: any) => r.table_name));
  assertTrue(
    names.has("tracker_work_item_runs"),
    "tracker_work_item_runs table exists",
  );
  assertTrue(
    names.has("tracker_project_seq"),
    "tracker_project_seq table exists",
  );

  const runCols = await exec.execute(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'tracker_work_item_runs'`,
  );
  const runColNames = new Set(runCols.rows.map((r: any) => r.column_name));
  for (const c of [
    "work_item_id",
    "run_id",
    "thread_id",
    "branch",
    "superseded",
    "dispatched_at",
  ]) {
    assertTrue(runColNames.has(c), `tracker_work_item_runs.${c} column exists`);
  }
  const seqCols = await exec.execute(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'tracker_project_seq'`,
  );
  const seqColNames = new Set(seqCols.rows.map((r: any) => r.column_name));
  assertTrue(
    seqColNames.has("project_id"),
    "tracker_project_seq.project_id column exists",
  );
  assertTrue(
    seqColNames.has("next_seq"),
    "tracker_project_seq.next_seq column exists",
  );

  const seqRows = await exec.execute(
    `SELECT count(*)::int as n FROM tracker_project_seq`,
  );
  assertTrue(
    (seqRows.rows[0] as any).n === 0,
    "empty db: zero tracker_project_seq rows (nothing to backfill)",
  );
}

// PHASE 2 — T-F8-06 tier B: simulate a db that already had projects/work_items
// BEFORE v27 ran (the real upgrade path). Run the full migration once (empty),
// reset ONLY the v27 bookkeeping row + its two tables, insert genuine legacy
// rows, then re-run — this time only v27 is pending, so its backfill
// INSERT...SELECT runs against real pre-existing data.
async function phase2() {
  log("=== PHASE 2: existing-db migration backfill (T-F8-06 tier B) ===");
  // getDbExec()'s pooled connection is a module-level singleton (only reset
  // via closeDbExec()) — close it before pointing at a DIFFERENT database.
  const { closeDbExec, getDbExec } = await import("@agent-native/core/db");
  await closeDbExec();
  process.env.DATABASE_URL = legacyUrl;

  const mod = await import("../server/plugins/db.js");
  const runMigrations = mod.default as unknown as () => Promise<void>;
  await runMigrations(); // v1..v27 fresh, empty

  const exec = getDbExec();

  await exec.execute(`DELETE FROM tracker_migrations WHERE version = 27`);
  await exec.execute(`DROP TABLE IF EXISTS tracker_work_item_runs`);
  await exec.execute(`DROP TABLE IF EXISTS tracker_project_seq`);

  const now = new Date().toISOString();
  await exec.execute({
    sql: `INSERT INTO tracker_projects (id, key, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      "legacy-proj",
      "LEG",
      "Legacy Project",
      now,
      now,
      "owner@example.com",
    ],
  });
  for (let n = 1; n <= 5; n++) {
    const key = `LEG-${String(n).padStart(3, "0")}`;
    await exec.execute({
      sql: `INSERT INTO tracker_work_items (id, project_id, title, item_key, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        `legacy-${n}`,
        "legacy-proj",
        `Legacy item ${n}`,
        key,
        now,
        now,
        "owner@example.com",
      ],
    });
  }

  await runMigrations(); // only v27 pending now

  const seqRow = await exec.execute(
    `SELECT next_seq FROM tracker_project_seq WHERE project_id = 'legacy-proj'`,
  );
  assertTrue(
    seqRow.rows.length === 1,
    "backfill created exactly one tracker_project_seq row for legacy-proj",
  );
  assertTrue(
    Number((seqRow.rows[0] as any)?.next_seq) === 5,
    `backfill next_seq = 5 (max existing LEG-005), got ${JSON.stringify(seqRow.rows[0])}`,
  );

  // T-F8-02 against real Postgres: the very next allocation must be LEG-006.
  const { allocateItemKey } =
    await import("../server/lib/item-key-sequencer.js");
  const next = await allocateItemKey("legacy-proj", "LEG");
  assertTrue(
    next === "LEG-006",
    `first post-backfill allocation is LEG-006, got ${next}`,
  );
}

// PHASE 3 — T-F8-01: 20-way REAL concurrent allocateItemKey against the SAME
// project_id, 3 rounds (fresh project id per round), zero duplicate itemKeys.
async function phase3() {
  log("=== PHASE 3: T-F8-01 — 20-way real Postgres concurrency, 3 rounds ===");
  process.env.DATABASE_URL = legacyUrl;
  const { allocateItemKey } =
    await import("../server/lib/item-key-sequencer.js");

  for (let round = 1; round <= 3; round++) {
    const projectId = `conc-proj-${round}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => allocateItemKey(projectId, "CON")),
    );
    const unique = new Set(results);
    assertTrue(
      unique.size === 20,
      `round ${round}: 20 concurrent allocateItemKey calls -> 20 unique itemKeys (got ${unique.size} unique of ${results.length}; sample=${JSON.stringify(results.slice(0, 5))})`,
    );
    const nums = results
      .map((r) => parseInt(r.split("-")[1]!, 10))
      .sort((a, b) => a - b);
    const expected = Array.from({ length: 20 }, (_, i) => i + 1);
    assertTrue(
      JSON.stringify(nums) === JSON.stringify(expected),
      `round ${round}: numbers are exactly 1..20 contiguous, no gaps/dupes (got ${JSON.stringify(nums)})`,
    );
  }
}

async function main() {
  await phase1();
  await phase2();
  await phase3();
  console.log(
    `\n[f8-pg-verify] ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[f8-pg-verify] FATAL:", err);
  process.exit(1);
});
