import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sqlite: Database.Database;

const rawClient = {
  execute: vi.fn(async (input: string | { sql: string; args?: unknown[] }) => {
    if (typeof input === "string") {
      sqlite.exec(input);
      return { rows: [], rowsAffected: 0 };
    }
    const stmt = sqlite.prepare(input.sql);
    const args = (input.args ?? []) as unknown[];
    if (/^\s*select/i.test(input.sql)) {
      return { rows: stmt.all(...args), rowsAffected: 0 };
    }
    const info = stmt.run(...args);
    return { rows: [], rowsAffected: info.changes };
  }),
};

vi.mock("../db/client.js", () => ({
  getDbExec: () => rawClient,
  intType: () => "INTEGER",
  isPostgres: () => false,
}));

const { appendEventLog, readEventLog } = await import("./store.js");

// ensureTable() caches its CREATE TABLE in a module-level _initPromise that runs
// only once across the file. After the first test triggers it, the per-test
// fresh in-memory DB won't get the table re-created, so we create it here in
// beforeEach to mirror the live SQLite DDL (the init-DDL test asserts the real
// CREATE TABLE/index SQL is issued).
function createSchema(): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS event_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    owner_email TEXT,
    org_id TEXT,
    name TEXT NOT NULL,
    payload_json TEXT,
    emitted_at INTEGER NOT NULL
  )`);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  createSchema();
});

afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

describe("event-log store", () => {
  it("creates the table and hot-path indexes on init", async () => {
    const seen: string[] = [];
    const orig = rawClient.execute.getMockImplementation()!;
    rawClient.execute.mockImplementation(
      async (input: string | { sql: string; args?: unknown[] }) => {
        const sql = typeof input === "string" ? input : input.sql;
        seen.push(sql);
        return orig(input);
      },
    );

    await appendEventLog({
      id: "evt-1",
      name: "plan.created",
      ownerEmail: "alice@example.com",
      payloadJson: JSON.stringify({ planId: "p1" }),
      emittedAt: 1000,
    });

    rawClient.execute.mockImplementation(orig);

    expect(
      seen.some((s) => /CREATE TABLE IF NOT EXISTS event_log/.test(s)),
    ).toBe(true);
    expect(seen.some((s) => /INTEGER PRIMARY KEY AUTOINCREMENT/.test(s))).toBe(
      true,
    );
    expect(seen.some((s) => s.includes("event_log_seq_idx"))).toBe(true);
    expect(seen.some((s) => s.includes("event_log_owner_name_idx"))).toBe(true);
  });

  it("appends rows and reads them owner-scoped, oldest first, advancing the cursor", async () => {
    await appendEventLog({
      id: "e1",
      name: "plan.created",
      ownerEmail: "alice@example.com",
      payloadJson: JSON.stringify({ n: 1 }),
      emittedAt: 100,
    });
    await appendEventLog({
      id: "e2",
      name: "plan.created",
      ownerEmail: "alice@example.com",
      payloadJson: JSON.stringify({ n: 2 }),
      emittedAt: 200,
    });

    const { events, cursor } = await readEventLog("alice@example.com", {
      since: 0,
    });
    expect(events.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(events[0].seq).toBeLessThan(events[1].seq);
    expect(events[0].name).toBe("plan.created");
    expect(events[0].emittedAt).toBe(100);
    expect(cursor).toBe(events[1].seq);
  });

  it("returns only rows with seq > since (cursor continuation, no re-delivery)", async () => {
    for (let i = 1; i <= 3; i++) {
      await appendEventLog({
        id: `e${i}`,
        name: "plan.created",
        ownerEmail: "alice@example.com",
        payloadJson: JSON.stringify({ n: i }),
        emittedAt: i * 100,
      });
    }
    const first = await readEventLog("alice@example.com", { since: 0 });
    expect(first.events).toHaveLength(3);

    // Re-reading from the returned cursor yields nothing new.
    const second = await readEventLog("alice@example.com", {
      since: first.cursor,
    });
    expect(second.events).toHaveLength(0);
    expect(second.cursor).toBe(first.cursor);
  });

  it("scopes reads strictly to the owner; NULL-owner rows leak to nobody", async () => {
    await appendEventLog({
      id: "a1",
      name: "plan.created",
      ownerEmail: "alice@example.com",
      payloadJson: "null",
      emittedAt: 100,
    });
    await appendEventLog({
      id: "b1",
      name: "plan.created",
      ownerEmail: "bob@example.com",
      payloadJson: "null",
      emittedAt: 200,
    });
    // No owner → unscoped event, must not surface for any authenticated user.
    await appendEventLog({
      id: "n1",
      name: "plan.created",
      payloadJson: "null",
      emittedAt: 300,
    });

    const alice = await readEventLog("alice@example.com", { since: 0 });
    expect(alice.events.map((e) => e.emittedAt)).toEqual([100]);

    const bob = await readEventLog("bob@example.com", { since: 0 });
    expect(bob.events.map((e) => e.emittedAt)).toEqual([200]);
  });

  it("filters by names when provided", async () => {
    await appendEventLog({
      id: "x",
      name: "plan.created",
      ownerEmail: "alice@example.com",
      payloadJson: "null",
      emittedAt: 100,
    });
    await appendEventLog({
      id: "y",
      name: "plan.updated",
      ownerEmail: "alice@example.com",
      payloadJson: "null",
      emittedAt: 200,
    });

    const { events } = await readEventLog("alice@example.com", {
      since: 0,
      names: ["plan.created"],
    });
    expect(events.map((e) => e.name)).toEqual(["plan.created"]);
  });

  it("honors the limit (clamped) and reports the last returned seq as cursor", async () => {
    for (let i = 1; i <= 5; i++) {
      await appendEventLog({
        id: `e${i}`,
        name: "plan.created",
        ownerEmail: "alice@example.com",
        payloadJson: JSON.stringify({ n: i }),
        emittedAt: i,
      });
    }
    const { events, cursor } = await readEventLog("alice@example.com", {
      since: 0,
      limit: 2,
    });
    expect(events).toHaveLength(2);
    expect(cursor).toBe(events[1].seq);
  });

  it("returns null payload for unparseable payload_json without throwing", async () => {
    // Insert a deliberately broken payload directly.
    sqlite
      .prepare(
        `INSERT INTO event_log (id, owner_email, name, payload_json, emitted_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("bad", "alice@example.com", "plan.created", "{not json", 100);

    const { events } = await readEventLog("alice@example.com", { since: 0 });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toBeNull();
  });

  it("returns an empty result when the table does not exist", async () => {
    sqlite.exec("DROP TABLE IF EXISTS event_log");
    const { events, cursor } = await readEventLog("nobody@example.com", {
      since: 42,
    });
    expect(events).toEqual([]);
    expect(cursor).toBe(42);
  });
});
