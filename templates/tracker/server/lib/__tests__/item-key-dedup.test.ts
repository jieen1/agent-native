import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ============================================================================
// SDLC-027: boot-time backtrack dedup of historical colliding itemKeys
// (server/lib/item-key-dedup.ts).
//
// Same isolation convention as item-key-sequencer.test.ts: point
// process.env.DATABASE_URL at a throwaway SQLite file BEFORE the first
// getDb()/getDbExec() call (both singletons read it lazily), never the
// template's real local dev DB. dedupeLegacyItemKeys() reads/writes via
// Drizzle getDb() and mints replacement keys via allocateItemKey() (getDbExec),
// both against this one file.
// ============================================================================

let dbDir: string;
let dbPath: string;
let originalDatabaseUrl: string | undefined;

beforeAll(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "item-key-dedup-"));
  dbPath = path.join(dbDir, "test.db");
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${dbPath}`;
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  const { closeDbExec } = await import("@agent-native/core/db");
  await closeDbExec?.().catch(() => {});
  fs.rmSync(dbDir, { recursive: true, force: true });
});

// Minimal real tables (column names match server/db/schema.ts). Only the
// columns dedupeLegacyItemKeys() touches are declared — Drizzle SELECT/INSERT
// reference exactly these.
async function setup() {
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_projects (
       id TEXT PRIMARY KEY,
       key TEXT NOT NULL,
       owner_email TEXT NOT NULL DEFAULT 'local@localhost',
       org_id TEXT,
       visibility TEXT NOT NULL DEFAULT 'private'
     )`,
  );
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_work_items (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       item_key TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       owner_email TEXT NOT NULL DEFAULT 'local@localhost',
       org_id TEXT,
       visibility TEXT NOT NULL DEFAULT 'private'
     )`,
  );
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_project_seq (project_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)`,
  );
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_activities (
       id TEXT PRIMARY KEY,
       work_item_id TEXT NOT NULL,
       actor_kind TEXT,
       actor_name TEXT,
       event_type TEXT NOT NULL,
       payload TEXT,
       created_at TEXT NOT NULL,
       owner_email TEXT NOT NULL DEFAULT 'local@localhost',
       org_id TEXT,
       visibility TEXT NOT NULL DEFAULT 'private'
     )`,
  );
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_comments (
       id TEXT PRIMARY KEY,
       work_item_id TEXT NOT NULL,
       author_kind TEXT,
       author_name TEXT,
       body TEXT NOT NULL,
       created_at TEXT NOT NULL,
       owner_email TEXT NOT NULL DEFAULT 'local@localhost',
       org_id TEXT,
       visibility TEXT NOT NULL DEFAULT 'private'
     )`,
  );
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_links (
       id TEXT PRIMARY KEY,
       from_item_id TEXT NOT NULL,
       to_item_id TEXT NOT NULL,
       link_type TEXT NOT NULL,
       created_at TEXT NOT NULL,
       owner_email TEXT NOT NULL DEFAULT 'local@localhost',
       org_id TEXT,
       visibility TEXT NOT NULL DEFAULT 'private'
     )`,
  );
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_stages (
       id TEXT PRIMARY KEY,
       work_item_id TEXT NOT NULL,
       stage_name TEXT NOT NULL,
       created_at TEXT NOT NULL,
       owner_email TEXT NOT NULL DEFAULT 'local@localhost',
       org_id TEXT,
       visibility TEXT NOT NULL DEFAULT 'private'
     )`,
  );
  return exec;
}

afterEach(async () => {
  vi.restoreAllMocks();
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  for (const t of [
    "tracker_projects",
    "tracker_work_items",
    "tracker_project_seq",
    "tracker_activities",
    "tracker_comments",
    "tracker_links",
    "tracker_stages",
  ]) {
    await exec.execute(`DELETE FROM ${t}`);
  }
});

async function insertProject(id: string, key: string) {
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  await exec.execute({
    sql: `INSERT INTO tracker_projects (id, key) VALUES (?, ?)`,
    args: [id, key],
  });
}

async function insertWorkItem(
  id: string,
  projectId: string,
  itemKey: string,
  createdAt: string,
) {
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  await exec.execute({
    sql: `INSERT INTO tracker_work_items (id, project_id, item_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    args: [id, projectId, itemKey, createdAt, createdAt],
  });
}

async function allRows(table: string) {
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  const res = await exec.execute(`SELECT * FROM ${table}`);
  return res.rows as Array<Record<string, unknown>>;
}

describe("dedupeLegacyItemKeys", () => {
  it("two duplicate rows: older keeps its key, newer is reassigned a fresh non-colliding key with exactly one activity + one comment", async () => {
    await setup();
    await insertProject("proj-1", "PAY");
    await insertWorkItem(
      "wi-old",
      "proj-1",
      "PAY-001",
      "2026-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-new",
      "proj-1",
      "PAY-001",
      "2026-02-01T00:00:00.000Z",
    );

    const { dedupeLegacyItemKeys } = await import("../item-key-dedup.js");
    const result = await dedupeLegacyItemKeys();

    expect(result.groupsFixed).toBe(1);
    expect(result.rowsReassigned).toBe(1);

    const items = await allRows("tracker_work_items");
    const old = items.find((r) => r.id === "wi-old");
    const neu = items.find((r) => r.id === "wi-new");
    expect(old?.item_key).toBe("PAY-001"); // authoritative, untouched
    expect(neu?.item_key).not.toBe("PAY-001");
    // Fresh key must not collide with any existing key in the project.
    const keys = items.map((r) => r.item_key);
    expect(new Set(keys).size).toBe(keys.length);

    const activities = await allRows("tracker_activities");
    const comments = await allRows("tracker_comments");
    expect(activities).toHaveLength(1);
    expect(comments).toHaveLength(1);
    expect(activities[0]?.work_item_id).toBe("wi-new");
    expect(comments[0]?.work_item_id).toBe("wi-new");
    expect(activities[0]?.event_type).toBe("item_key.reassigned");
  });

  it("a 3-way collision: 1 authoritative + 2 reassigned, all 3 rows still present (none deleted)", async () => {
    await setup();
    await insertProject("proj-1", "PAY");
    await insertWorkItem(
      "wi-a",
      "proj-1",
      "PAY-005",
      "2026-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-b",
      "proj-1",
      "PAY-005",
      "2026-02-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-c",
      "proj-1",
      "PAY-005",
      "2026-03-01T00:00:00.000Z",
    );

    const { dedupeLegacyItemKeys } = await import("../item-key-dedup.js");
    const result = await dedupeLegacyItemKeys();

    expect(result.groupsFixed).toBe(1);
    expect(result.rowsReassigned).toBe(2);

    const items = await allRows("tracker_work_items");
    expect(items).toHaveLength(3);
    expect(items.find((r) => r.id === "wi-a")?.item_key).toBe("PAY-005");
    const keys = items.map((r) => r.item_key);
    expect(new Set(keys).size).toBe(3); // all unique now
    expect((await allRows("tracker_activities")).length).toBe(2);
    expect((await allRows("tracker_comments")).length).toBe(2);
  });

  it("two DIFFERENT projects sharing the same literal item_key are NOT cross-matched (grouping is per project_id)", async () => {
    await setup();
    await insertProject("proj-a", "AAA");
    await insertProject("proj-b", "BBB");
    await insertWorkItem(
      "wi-a1",
      "proj-a",
      "SHARED-001",
      "2026-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-b1",
      "proj-b",
      "SHARED-001",
      "2026-01-02T00:00:00.000Z",
    );

    const { dedupeLegacyItemKeys } = await import("../item-key-dedup.js");
    const result = await dedupeLegacyItemKeys();

    expect(result.groupsFixed).toBe(0);
    expect(result.rowsReassigned).toBe(0);
    const items = await allRows("tracker_work_items");
    expect(items.find((r) => r.id === "wi-a1")?.item_key).toBe("SHARED-001");
    expect(items.find((r) => r.id === "wi-b1")?.item_key).toBe("SHARED-001");
    expect((await allRows("tracker_activities")).length).toBe(0);
  });

  it("pre-existing comment + link rows referencing a reassigned item's id are untouched (only item_key changes)", async () => {
    const exec = await setup();
    await insertProject("proj-1", "PAY");
    await insertWorkItem(
      "wi-old",
      "proj-1",
      "PAY-009",
      "2026-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-new",
      "proj-1",
      "PAY-009",
      "2026-02-01T00:00:00.000Z",
    );
    // A human comment and a link edge that point at the to-be-reassigned row.
    await exec.execute({
      sql: `INSERT INTO tracker_comments (id, work_item_id, author_kind, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        "cmt-1",
        "wi-new",
        "human",
        "dev@x.com",
        "原始评论",
        "2026-02-02T00:00:00.000Z",
      ],
    });
    await exec.execute({
      sql: `INSERT INTO tracker_links (id, from_item_id, to_item_id, link_type, created_at) VALUES (?, ?, ?, ?, ?)`,
      args: ["lnk-1", "wi-old", "wi-new", "blocks", "2026-02-03T00:00:00.000Z"],
    });

    const { dedupeLegacyItemKeys } = await import("../item-key-dedup.js");
    await dedupeLegacyItemKeys();

    // The human comment is still there, still pointing at wi-new, body intact.
    const comments = await allRows("tracker_comments");
    const human = comments.find((c) => c.id === "cmt-1");
    expect(human?.work_item_id).toBe("wi-new");
    expect(human?.body).toBe("原始评论");
    // The link edge is unchanged (both endpoints reference internal ids).
    const links = await allRows("tracker_links");
    expect(links).toHaveLength(1);
    expect(links[0]?.from_item_id).toBe("wi-old");
    expect(links[0]?.to_item_id).toBe("wi-new");
    // And the reassigned work item still exists under the same id.
    const items = await allRows("tracker_work_items");
    expect(items.find((r) => r.id === "wi-new")).toBeTruthy();
  });

  it("is idempotent: a second back-to-back call makes no further changes and inserts no further audit rows", async () => {
    await setup();
    await insertProject("proj-1", "PAY");
    await insertWorkItem(
      "wi-old",
      "proj-1",
      "PAY-002",
      "2026-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-new",
      "proj-1",
      "PAY-002",
      "2026-02-01T00:00:00.000Z",
    );

    const { dedupeLegacyItemKeys } = await import("../item-key-dedup.js");
    await dedupeLegacyItemKeys();
    const itemsAfterFirst = await allRows("tracker_work_items");
    const actsAfterFirst = (await allRows("tracker_activities")).length;
    const cmtsAfterFirst = (await allRows("tracker_comments")).length;

    const second = await dedupeLegacyItemKeys();
    expect(second.groupsFixed).toBe(0);
    expect(second.rowsReassigned).toBe(0);
    expect(await allRows("tracker_work_items")).toEqual(itemsAfterFirst);
    expect((await allRows("tracker_activities")).length).toBe(actsAfterFirst);
    expect((await allRows("tracker_comments")).length).toBe(cmtsAfterFirst);
  });

  it("blank item_key rows are never treated as duplicates even when many share the blank value", async () => {
    // (schema declares item_key NOT NULL DEFAULT '', so blanks are '' in
    // practice; the dedup query guards both '' and NULL defensively.)
    await setup();
    await insertProject("proj-1", "PAY");
    await insertWorkItem(
      "wi-blank-1",
      "proj-1",
      "",
      "2026-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-blank-2",
      "proj-1",
      "",
      "2026-01-02T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-blank-3",
      "proj-1",
      "",
      "2026-01-03T00:00:00.000Z",
    );

    const { dedupeLegacyItemKeys } = await import("../item-key-dedup.js");
    const result = await dedupeLegacyItemKeys();

    expect(result.groupsFixed).toBe(0);
    expect(result.rowsReassigned).toBe(0);
    expect((await allRows("tracker_activities")).length).toBe(0);
    const items = await allRows("tracker_work_items");
    expect(items.find((r) => r.id === "wi-blank-1")?.item_key).toBe("");
    expect(items.find((r) => r.id === "wi-blank-2")?.item_key).toBe("");
    expect(items.find((r) => r.id === "wi-blank-3")?.item_key).toBe("");
  });

  it("concurrent-boot race: when the row's item_key was already re-keyed by another process between read and write, the guarded UPDATE matches nothing and NO activity/comment audit rows are inserted (no throw)", async () => {
    await setup();
    await insertProject("proj-1", "PAY");
    await insertWorkItem(
      "wi-old",
      "proj-1",
      "PAY-001",
      "2026-01-01T00:00:00.000Z",
    );
    await insertWorkItem(
      "wi-new",
      "proj-1",
      "PAY-001",
      "2026-02-01T00:00:00.000Z",
    );

    // Simulate a concurrent winner: a second boot/replica that already
    // detected the SAME duplicate group and re-keyed wi-new to PAY-999 BEFORE
    // this call's per-row write fires. We mutate the row inside
    // allocateItemKey() — which dedupeLegacyItemKeys() calls AFTER it reads the
    // row (observing item_key "PAY-001") but BEFORE its guarded UPDATE — so the
    // guarded UPDATE's `item_key = <observed>` clause no longer matches.
    const sequencer = await import("../item-key-sequencer.js");
    const allocateSpy = vi
      .spyOn(sequencer, "allocateItemKey")
      .mockImplementation(async (projectId: string, projectKey: string) => {
        const { getDbExec } = await import("@agent-native/core/db");
        const exec = getDbExec();
        await exec.execute({
          sql: `UPDATE tracker_work_items SET item_key = ? WHERE id = ?`,
          args: ["PAY-999", "wi-new"],
        });
        // Return a plausible freshly-allocated key (the value this "loser"
        // instance would have written had it won the race).
        return `${projectKey}-888`;
      });

    const { dedupeLegacyItemKeys } = await import("../item-key-dedup.js");
    // Must NOT throw even though it lost the race.
    const result = await dedupeLegacyItemKeys();

    expect(allocateSpy).toHaveBeenCalledTimes(1);
    // This instance lost the race → it reassigned nothing.
    expect(result.rowsReassigned).toBe(0);

    // The concurrent winner's key stands; this instance's minted key was NOT
    // written (the guarded UPDATE matched nothing).
    const items = await allRows("tracker_work_items");
    expect(items.find((r) => r.id === "wi-new")?.item_key).toBe("PAY-999");
    expect(items.find((r) => r.id === "wi-old")?.item_key).toBe("PAY-001");

    // The crux of the fix: NO audit rows from the losing instance — exactly
    // one reassignment ever happened, so there must be zero activity/comment
    // rows (the winner, being simulated by a raw UPDATE above, wrote none).
    expect((await allRows("tracker_activities")).length).toBe(0);
    expect((await allRows("tracker_comments")).length).toBe(0);
  });
});
