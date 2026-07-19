import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// NOTE: tracker schema + dedupeItemKeys are imported DYNAMICALLY inside
// beforeAll (below), NOT statically at the top — see the dialect-binding note
// in the harness comment further down. Their types are aliased here so the
// rest of the file reads exactly like item-key-display.test.ts.
type TrackerSchema = typeof import("../../db/schema.js");
type DedupeFn = typeof import("../dedupe-item-keys.js").dedupeItemKeys;

// ============================================================================
// SDLC-038 retroactive dedup migration (server/lib/dedupe-item-keys.ts).
//
// dedupeItemKeys(db) reassigns a brand-new itemKey to every "losing" duplicate
// row (same projectId + itemKey, >1 row), keeping the earliest-created row as
// canonical. The freshly-minted key comes from allocateItemKey() — the SAME
// atomic project-level sequencer create-work-item uses.
//
// CRITICAL TEST HARNESS NOTE — two connections, one physical file:
//   * `db` (drizzle over a @libsql/client `createClient`) is what we pass INTO
//     dedupeItemKeys — it does the group read, the item_key UPDATE, and the
//     comment/activity INSERTs.
//   * allocateItemKey() (called internally by dedupeItemKeys) does NOT use that
//     drizzle handle — it uses the framework's process-wide `getDbExec()`
//     singleton (raw SQL with dialect branching Drizzle doesn't expose).
//   So — same convention as item-key-sequencer.test.ts and
//   server/plugins/__tests__/db-migration.test.ts — we point
//   `process.env.DATABASE_URL` at the SAME throwaway libsql file BEFORE the
//   first getDbExec() call, so both connections read/write one physical
//   database. (WAL mode makes the libsql client's writes immediately visible
//   to the better-sqlite3-backed getDbExec() connection, and vice-versa.)
//   Without this, allocateItemKey would read/write an uninitialized / wrong
//   database and the reassignment would silently land nowhere.
//
// DIALECT BINDING (why the dynamic imports): the framework's `getDialect()`
// caches the dialect on its FIRST call, and tracker's schema.ts evaluates its
// top-level `table(...)`/`ownableColumns()` calls at module-load time — each of
// which calls getDialect(). If we statically imported schema.ts (or
// dedupe-item-keys.ts, which imports it), that first call would happen during
// module evaluation, when `process.env.DATABASE_URL` still holds the ambient
// value (a real postgres:// URL in CI), permanently caching dialect="postgres".
// allocateItemKey would then take its Postgres branch (`substring(... from
// ...)`) against the better-sqlite3 getDbExec() connection -> syntax error,
// swallowed by dedupeItemKeys' fail-open. So — the same dynamic-import
// discipline item-key-sequencer.test.ts uses — we set DATABASE_URL to the
// throwaway file FIRST, then dynamically import schema + dedupeItemKeys, so the
// first getDialect() call sees `file:` and binds sqlite for the whole run.
//
// The manual CREATE TABLE below mirrors item-key-display.test.ts's ephemeral-db
// pattern, with columns aligned to db.ts/schema.ts's REAL columns (only the
// ones these code paths touch). tracker_project_seq is created here too so both
// the drizzle and the getDbExec connection see it.
// ============================================================================

const OWNER = "owner@example.com";
const ORG_ID = "org-dedupe";

let client: Client;
let db: LibSQLDatabase<TrackerSchema>;
let dbDir: string;
let originalDatabaseUrl: string | undefined;
let dedupeItemKeys: DedupeFn;

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dedupe-item-keys-"));
  const dbPath = path.join(dbDir, "test.db");
  // Bind the framework's getDbExec() singleton (used by allocateItemKey) to the
  // SAME file the drizzle client below opens — must happen before any
  // getDbExec()/getDialect() call (see harness notes above).
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${dbPath}`;
  // Import schema + dedupeItemKeys ONLY now, after the file: URL is set, so the
  // first getDialect() call binds sqlite (not the ambient postgres URL).
  const trackerSchema = await import("../../db/schema.js");
  ({ dedupeItemKeys } = await import("../dedupe-item-keys.js"));
  client = createClient({ url: `file:${dbPath}` });
  db = drizzle(client, { schema: trackerSchema });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DROP TABLE IF EXISTS tracker_work_items;
    DROP TABLE IF EXISTS tracker_projects;
    DROP TABLE IF EXISTS tracker_project_seq;
    DROP TABLE IF EXISTS tracker_comments;
    DROP TABLE IF EXISTS tracker_activities;
    CREATE TABLE tracker_projects (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      item_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_project_seq (
      project_id TEXT PRIMARY KEY,
      next_seq INTEGER NOT NULL
    );
    CREATE TABLE tracker_comments (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      author_kind TEXT DEFAULT 'human',
      author_name TEXT DEFAULT '',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_activities (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      actor_kind TEXT DEFAULT 'agent',
      actor_name TEXT DEFAULT '智能体',
      event_type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);
});

afterAll(async () => {
  client?.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  const { closeDbExec } = await import("@agent-native/core/db");
  await closeDbExec?.().catch(() => {});
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function insertProject(id: string, key: string) {
  await client.execute({
    sql: `INSERT INTO tracker_projects (id, key, name, owner_email, org_id) VALUES (?, ?, ?, ?, ?)`,
    args: [id, key, `Project ${key}`, OWNER, ORG_ID],
  });
}

async function insertWorkItem(
  id: string,
  projectId: string,
  itemKey: string,
  createdAt: string,
) {
  await client.execute({
    sql: `INSERT INTO tracker_work_items (id, project_id, item_key, created_at, updated_at, owner_email, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, projectId, itemKey, createdAt, createdAt, OWNER, ORG_ID],
  });
}

async function getItemKey(id: string): Promise<string> {
  const res = await client.execute({
    sql: `SELECT item_key FROM tracker_work_items WHERE id = ?`,
    args: [id],
  });
  return String(
    (res.rows[0] as { item_key?: string } | undefined)?.item_key ?? "",
  );
}

async function countRows(table: string, workItemId: string): Promise<number> {
  const res = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM ${table} WHERE work_item_id = ?`,
    args: [workItemId],
  });
  return Number((res.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

async function getCommentBodies(workItemId: string): Promise<string[]> {
  const res = await client.execute({
    sql: `SELECT body FROM tracker_comments WHERE work_item_id = ? ORDER BY created_at`,
    args: [workItemId],
  });
  return res.rows.map((r) => String((r as { body?: string }).body ?? ""));
}

/** Count (project_id, item_key) pairs that appear more than once within a
 *  project — i.e. remaining duplicates. 0 means every itemKey is unique per
 *  project. */
async function countDuplicateKeysInProject(projectId: string): Promise<number> {
  const res = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT project_id, item_key FROM tracker_work_items
            WHERE project_id = ? AND item_key != ''
            GROUP BY project_id, item_key HAVING COUNT(*) > 1
          )`,
    args: [projectId],
  });
  return Number((res.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

describe("dedupeItemKeys", () => {
  it("a real duplicate pair: the earlier-created item keeps its key, the later one is reassigned a new unique key + exactly one system comment and one activity referencing both keys", async () => {
    await insertProject("proj-1", "SDLC");
    // wi-a created earlier, wi-b later — both collided on SDLC-033.
    await insertWorkItem(
      "wi-a",
      "proj-1",
      "SDLC-033",
      "2024-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-b",
      "proj-1",
      "SDLC-033",
      "2024-01-02T00:00:00.000Z",
    );

    const report = await dedupeItemKeys(db as any);

    // Exactly one loser (the later-created wi-b).
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      workItemId: "wi-b",
      projectId: "proj-1",
      oldKey: "SDLC-033",
    });

    // Canonical (earlier) row keeps its original key untouched.
    expect(await getItemKey("wi-a")).toBe("SDLC-033");

    // Loser got a NEW, different, non-empty key using the project's prefix.
    const newKey = report[0]!.newKey;
    expect(newKey).toBeTruthy();
    expect(newKey).not.toBe("SDLC-033");
    expect(newKey.startsWith("SDLC-")).toBe(true);
    expect(await getItemKey("wi-b")).toBe(newKey);

    // Exactly one system comment + one activity on the loser, none on canonical.
    expect(await countRows("tracker_comments", "wi-b")).toBe(1);
    expect(await countRows("tracker_activities", "wi-b")).toBe(1);
    expect(await countRows("tracker_comments", "wi-a")).toBe(0);
    expect(await countRows("tracker_activities", "wi-a")).toBe(0);

    // The comment body references BOTH the old and the new key.
    const bodies = await getCommentBodies("wi-b");
    expect(bodies[0]).toContain("SDLC-033");
    expect(bodies[0]).toContain(newKey);
  });

  it("a three-way collision: one keeps the original key, the other two each get a DISTINCT new key (the two reassigned keys don't collide with each other)", async () => {
    await insertProject("proj-1", "SDLC");
    await insertWorkItem(
      "wi-a",
      "proj-1",
      "SDLC-050",
      "2024-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-b",
      "proj-1",
      "SDLC-050",
      "2024-01-02T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-c",
      "proj-1",
      "SDLC-050",
      "2024-01-03T00:00:00.000Z",
    );

    const report = await dedupeItemKeys(db as any);

    // Two losers (the two later-created rows).
    expect(report).toHaveLength(2);
    const loserIds = report.map((r) => r.workItemId).sort();
    expect(loserIds).toEqual(["wi-b", "wi-c"]);

    // Canonical (earliest) keeps its key.
    expect(await getItemKey("wi-a")).toBe("SDLC-050");

    // Each loser got a distinct, non-empty, prefixed key — and neither equals
    // the original nor each other.
    const newKeys = report.map((r) => r.newKey);
    expect(newKeys[0]).toBeTruthy();
    expect(newKeys[1]).toBeTruthy();
    expect(newKeys[0]).not.toBe("SDLC-050");
    expect(newKeys[1]).not.toBe("SDLC-050");
    expect(newKeys[0]).not.toBe(newKeys[1]);
    for (const k of newKeys) expect(k.startsWith("SDLC-")).toBe(true);

    // Each loser carries its own comment + activity.
    expect(await countRows("tracker_comments", "wi-b")).toBe(1);
    expect(await countRows("tracker_activities", "wi-b")).toBe(1);
    expect(await countRows("tracker_comments", "wi-c")).toBe(1);
    expect(await countRows("tracker_activities", "wi-c")).toBe(1);
    expect(await countRows("tracker_comments", "wi-a")).toBe(0);
  });

  it("non-duplicate work items are completely untouched (no comment / no activity inserted, itemKey unchanged)", async () => {
    await insertProject("proj-1", "SDLC");
    await insertWorkItem(
      "wi-a",
      "proj-1",
      "SDLC-001",
      "2024-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-b",
      "proj-1",
      "SDLC-002",
      "2024-01-02T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-c",
      "proj-1",
      "SDLC-003",
      "2024-01-03T00:00:00.000Z",
    );

    const report = await dedupeItemKeys(db as any);

    expect(report).toEqual([]);
    expect(await getItemKey("wi-a")).toBe("SDLC-001");
    expect(await getItemKey("wi-b")).toBe("SDLC-002");
    expect(await getItemKey("wi-c")).toBe("SDLC-003");
    expect(await countRows("tracker_comments", "wi-a")).toBe(0);
    expect(await countRows("tracker_activities", "wi-a")).toBe(0);
    expect(await countRows("tracker_comments", "wi-b")).toBe(0);
    expect(await countRows("tracker_comments", "wi-c")).toBe(0);
  });

  it("the SAME itemKey string in DIFFERENT projects is NOT a collision", async () => {
    await insertProject("proj-1", "AAA");
    await insertProject("proj-2", "BBB");
    await insertWorkItem("wi-a", "proj-1", "X-001", "2024-01-01T00:00:00.000Z");
    await insertWorkItem("wi-b", "proj-2", "X-001", "2024-01-02T00:00:00.000Z");

    const report = await dedupeItemKeys(db as any);

    expect(report).toEqual([]);
    expect(await getItemKey("wi-a")).toBe("X-001");
    expect(await getItemKey("wi-b")).toBe("X-001");
    expect(await countRows("tracker_comments", "wi-a")).toBe(0);
    expect(await countRows("tracker_comments", "wi-b")).toBe(0);
  });

  it("a second run after a successful dedupe is a true no-op (empty report, no new writes)", async () => {
    await insertProject("proj-1", "SDLC");
    await insertWorkItem(
      "wi-a",
      "proj-1",
      "SDLC-033",
      "2024-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-b",
      "proj-1",
      "SDLC-033",
      "2024-01-02T00:00:00.000Z",
    );

    const first = await dedupeItemKeys(db as any);
    expect(first).toHaveLength(1);

    // Snapshot the full comment/activity tables, then re-run.
    const commentsBefore = await client.execute(
      `SELECT * FROM tracker_comments`,
    );
    const activitiesBefore = await client.execute(
      `SELECT * FROM tracker_activities`,
    );
    const itemsBefore = await client.execute(
      `SELECT id, item_key FROM tracker_work_items ORDER BY id`,
    );

    const second = await dedupeItemKeys(db as any);

    // Idempotent: nothing left to dedupe -> empty report, zero new writes.
    expect(second).toEqual([]);
    const commentsAfter = await client.execute(
      `SELECT * FROM tracker_comments`,
    );
    const activitiesAfter = await client.execute(
      `SELECT * FROM tracker_activities`,
    );
    const itemsAfter = await client.execute(
      `SELECT id, item_key FROM tracker_work_items ORDER BY id`,
    );
    expect(commentsAfter.rows).toEqual(commentsBefore.rows);
    expect(activitiesAfter.rows).toEqual(activitiesBefore.rows);
    expect(itemsAfter.rows).toEqual(itemsBefore.rows);
  });

  it("after reassignment the project has NO remaining (projectId, itemKey) duplicates", async () => {
    await insertProject("proj-1", "SDLC");
    // One three-way collision plus one independent duplicate pair, interleaved.
    await insertWorkItem(
      "wi-a",
      "proj-1",
      "SDLC-010",
      "2024-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-b",
      "proj-1",
      "SDLC-010",
      "2024-01-02T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-c",
      "proj-1",
      "SDLC-010",
      "2024-01-03T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-d",
      "proj-1",
      "SDLC-020",
      "2024-01-04T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-e",
      "proj-1",
      "SDLC-020",
      "2024-01-05T00:00:00.000Z",
    );

    expect(await countDuplicateKeysInProject("proj-1")).toBe(2);

    const report = await dedupeItemKeys(db as any);
    // 2 losers from the three-way group + 1 loser from the pair = 3 reassigns.
    expect(report).toHaveLength(3);

    // The freshly-minted keys never collide with anything else in the project.
    expect(await countDuplicateKeysInProject("proj-1")).toBe(0);

    // And every reassigned key is genuinely distinct from every other row's.
    const all = await client.execute({
      sql: `SELECT item_key FROM tracker_work_items WHERE project_id = ? AND item_key != ''`,
      args: ["proj-1"],
    });
    const keys = all.rows.map((r) =>
      String((r as { item_key?: string }).item_key),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
