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

const { insertRoutineRun, finishRoutineRun, listRoutineRuns } =
  await import("./store.js");

// ensureTable() caches its CREATE TABLE in a module-level _initPromise that
// runs only once across the whole file. After the first test triggers it, the
// per-test fresh in-memory database won't get the table re-created, so we
// create it here in beforeEach to mirror the live DDL (see the dedicated
// init-DDL test, which asserts the CREATE TABLE/index SQL is issued).
function createSchema(): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS routine_runs (
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

describe("routine-runs store", () => {
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

    await insertRoutineRun({
      ownerEmail: "alice@example.com",
      routineName: "morning-report",
      kind: "schedule",
      trigger: "0 9 * * *",
      threadId: "thread-1",
      status: "running",
      startedAt: 1000,
    });

    rawClient.execute.mockImplementation(orig);

    expect(
      seen.some((s) => /CREATE TABLE IF NOT EXISTS routine_runs/.test(s)),
    ).toBe(true);
    expect(seen.some((s) => s.includes("routine_runs_owner_started_idx"))).toBe(
      true,
    );
    expect(seen.some((s) => s.includes("routine_runs_name_started_idx"))).toBe(
      true,
    );
  });

  it("inserts a running row and updates it to a terminal status", async () => {
    const id = await insertRoutineRun({
      ownerEmail: "alice@example.com",
      routineName: "morning-report",
      kind: "schedule",
      trigger: "0 9 * * *",
      threadId: "thread-1",
      status: "running",
      startedAt: 1000,
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    let runs = await listRoutineRuns("alice@example.com");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id,
      ownerEmail: "alice@example.com",
      routineName: "morning-report",
      kind: "schedule",
      trigger: "0 9 * * *",
      threadId: "thread-1",
      status: "running",
      startedAt: 1000,
      finishedAt: null,
      error: null,
    });

    await finishRoutineRun(id, { status: "success", finishedAt: 2000 });

    runs = await listRoutineRuns("alice@example.com");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id,
      status: "success",
      finishedAt: 2000,
      error: null,
    });
  });

  it("records error status with the error message", async () => {
    const id = await insertRoutineRun({
      ownerEmail: "alice@example.com",
      routineName: "flaky",
      kind: "event",
      trigger: "test.event.fired",
      threadId: "thread-2",
      status: "running",
      startedAt: 5000,
    });
    await finishRoutineRun(id, {
      status: "error",
      error: "boom",
      finishedAt: 6000,
    });

    const runs = await listRoutineRuns("alice@example.com");
    expect(runs[0]).toMatchObject({
      kind: "event",
      trigger: "test.event.fired",
      status: "error",
      error: "boom",
      finishedAt: 6000,
    });
  });

  it("scopes reads to the owner and returns newest first", async () => {
    await insertRoutineRun({
      ownerEmail: "alice@example.com",
      routineName: "a",
      kind: "schedule",
      status: "running",
      startedAt: 100,
    });
    await insertRoutineRun({
      ownerEmail: "alice@example.com",
      routineName: "b",
      kind: "schedule",
      status: "running",
      startedAt: 300,
    });
    await insertRoutineRun({
      ownerEmail: "bob@example.com",
      routineName: "c",
      kind: "schedule",
      status: "running",
      startedAt: 200,
    });

    const alice = await listRoutineRuns("alice@example.com");
    expect(alice.map((r) => r.routineName)).toEqual(["b", "a"]);

    const bob = await listRoutineRuns("bob@example.com");
    expect(bob.map((r) => r.routineName)).toEqual(["c"]);
  });

  it("filters by routine name when requested", async () => {
    await insertRoutineRun({
      ownerEmail: "alice@example.com",
      routineName: "a",
      kind: "schedule",
      status: "running",
      startedAt: 100,
    });
    await insertRoutineRun({
      ownerEmail: "alice@example.com",
      routineName: "b",
      kind: "schedule",
      status: "running",
      startedAt: 200,
    });

    const onlyA = await listRoutineRuns("alice@example.com", {
      routineName: "a",
    });
    expect(onlyA.map((r) => r.routineName)).toEqual(["a"]);
  });

  it("records two concurrent runs of the SAME routine as separate, non-crossing rows (manual run racing a tick)", async () => {
    // A manual `run-routine` and a scheduled tick can hit the same routine at
    // once. Each gets its own row: distinct ids, distinct triggers/threads, and
    // independent terminal statuses — one must never overwrite the other.
    const [manualId, tickId] = await Promise.all([
      insertRoutineRun({
        ownerEmail: "alice@example.com",
        routineName: "daily-brief",
        kind: "schedule",
        trigger: "manual",
        threadId: "thread-manual",
        status: "running",
        startedAt: 1000,
      }),
      insertRoutineRun({
        ownerEmail: "alice@example.com",
        routineName: "daily-brief",
        kind: "schedule",
        trigger: "0 8 * * *",
        threadId: "thread-tick",
        status: "running",
        startedAt: 1001,
      }),
    ]);

    expect(manualId).not.toBe(tickId);

    // Finish them to DIFFERENT terminal states, concurrently, by id.
    await Promise.all([
      finishRoutineRun(manualId, { status: "success", finishedAt: 2000 }),
      finishRoutineRun(tickId, {
        status: "error",
        error: "tick failed",
        finishedAt: 2001,
      }),
    ]);

    const runs = await listRoutineRuns("alice@example.com", {
      routineName: "daily-brief",
    });
    expect(runs).toHaveLength(2);

    const byThread = Object.fromEntries(runs.map((r) => [r.threadId, r]));
    // The manual run's row carries the manual trigger + success, untouched by
    // the tick's row, which carries the cron trigger + its own error.
    expect(byThread["thread-manual"]).toMatchObject({
      id: manualId,
      trigger: "manual",
      status: "success",
      error: null,
      finishedAt: 2000,
    });
    expect(byThread["thread-tick"]).toMatchObject({
      id: tickId,
      trigger: "0 8 * * *",
      status: "error",
      error: "tick failed",
      finishedAt: 2001,
    });
  });

  it("returns an empty array when the table does not exist", async () => {
    // Drop the table created by a prior call within ensureTable's cached
    // init: simulate a fresh DB where no run has been written by querying a
    // brand-new in-memory database without the table.
    sqlite.exec("DROP TABLE IF EXISTS routine_runs");
    const runs = await listRoutineRuns("nobody@example.com");
    expect(runs).toEqual([]);
  });
});
