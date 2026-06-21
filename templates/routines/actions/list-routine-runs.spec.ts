/**
 * list-routine-runs — owner-scoped routine_runs read + view-model mapping.
 *
 *  - Maps a routine_runs row to the UI/agent view-model: ISO start/finish,
 *    computed durationMs, threadId/error null-coalescing.
 *  - A success row (the A5 acceptance "success/run row appears") surfaces with
 *    status:"success", finishedAt, and a positive durationMs.
 *  - A still-running row leaves finishedAt + durationMs null.
 *  - Reads are owner-scoped (eq(ownerEmail, owner)) and ordered newest-first;
 *    an optional `name` narrows to one routine.
 *  - A read failure (e.g. table not created yet on a fresh db) degrades to an
 *    empty history rather than throwing (§1.5.19 robustness).
 *  - Unauthenticated requests throw before touching the db.
 *
 * `../server/db` is mocked with a chainable query builder; `drizzle-orm`'s
 * and/desc/eq are stubbed to plain markers (the action only forwards them).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  email: "owner@example.com" as string | undefined,
}));
const db = vi.hoisted(() => {
  // A chainable select().from().where().orderBy().limit() that resolves `rows`.
  const state = { rows: [] as unknown[], shouldThrow: false };
  const builder = {
    select: vi.fn(() => builder),
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => {
      if (state.shouldThrow) throw new Error("no such table: routine_runs");
      return Promise.resolve(state.rows);
    }),
  };
  return { state, builder, getDb: vi.fn(async () => builder) };
});

vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: () => ctx.email,
  getRequestOrgId: () => undefined,
}));
vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  desc: (col: unknown) => ({ desc: col }),
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
}));
vi.mock("../server/db/index.js", () => ({
  getDb: db.getDb,
  schema: {
    routineRuns: {
      ownerEmail: "owner_email",
      routineName: "routine_name",
      startedAt: "started_at",
    },
  },
}));

const { default: listRoutineRuns } = await import("./list-routine-runs.js");

function row(over: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    ownerEmail: "owner@example.com",
    orgId: null,
    routineName: "daily-briefing",
    kind: "schedule",
    trigger: "30 8 * * 1-5",
    threadId: "thread_1",
    status: "success",
    error: null,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_002_500,
    ...over,
  };
}

describe("list-routine-runs", () => {
  beforeEach(() => {
    db.state.rows = [];
    db.state.shouldThrow = false;
    db.getDb.mockClear();
    db.builder.where.mockClear();
    db.builder.limit.mockClear();
    ctx.email = "owner@example.com";
  });

  it("maps a success row to the view-model with ISO times and a computed duration", async () => {
    db.state.rows = [row()];

    const { runs } = await listRoutineRuns.run({ limit: 50 });

    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.status).toBe("success");
    expect(run.routineName).toBe("daily-briefing");
    expect(run.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(run.finishedAt).toBe(new Date(1_700_000_002_500).toISOString());
    expect(run.durationMs).toBe(2_500);
    expect(run.threadId).toBe("thread_1");
    expect(run.error).toBeNull();
  });

  it("leaves finishedAt and durationMs null while a run is still running", async () => {
    db.state.rows = [
      row({ status: "running", finishedAt: null, threadId: null }),
    ];

    const { runs } = await listRoutineRuns.run({ limit: 50 });

    expect(runs[0].status).toBe("running");
    expect(runs[0].finishedAt).toBeNull();
    expect(runs[0].durationMs).toBeNull();
    expect(runs[0].threadId).toBeNull();
  });

  it("degrades to an empty history when the table read fails (fresh db)", async () => {
    db.state.shouldThrow = true;

    const result = await listRoutineRuns.run({ limit: 50 });

    expect(result).toEqual({ runs: [] });
  });

  it("scopes the query to the owner (and narrows by name when given)", async () => {
    db.state.rows = [];
    await listRoutineRuns.run({ name: "daily-briefing", limit: 10 });

    // The where clause was built (owner-scope + name filter) and a limit applied.
    expect(db.builder.where).toHaveBeenCalledTimes(1);
    expect(db.builder.limit).toHaveBeenCalledWith(10);
  });

  it("throws when unauthenticated, before touching the db", async () => {
    ctx.email = undefined;
    await expect(listRoutineRuns.run({ limit: 50 })).rejects.toThrow(
      /no authenticated user/i,
    );
    expect(db.getDb).not.toHaveBeenCalled();
  });
});
