// S9 Brain console top task-context bar + composer's persisted repo/sprint
// chips (04 §6) read repo/baseBranch/tags off this action's response — unit
// tests for the new fields brain-task-slot.ts now selects, in particular the
// tags-filtering that strips the internal `brainThreadId` beacon (brain-send.ts)
// before handing tags to the UI.
//
// Mirrors v3-run-detail.spec.ts's mocking approach: real v3Schema (so the
// production code's `eq`/`and`/`desc` build against genuine Drizzle Column
// objects), a hand-rolled db stub that ignores the WHERE/ORDER BY and just
// returns the canned row.

import { describe, it, expect, beforeEach, vi } from "vitest";

import brainTaskSlot from "./brain-task-slot.js";

const hoisted = vi.hoisted(() => {
  const state = { tasks: [] as Array<Record<string, any>> };
  return { state };
});

vi.mock("../server/db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/db/index.js")>();
  return {
    ...actual,
    resolveOwnerEmail: () => "local@localhost",
    getV3Db: () => ({
      select: (_cols?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_filter: unknown) => ({
            orderBy: (_order: unknown) => ({
              limit: (n: number) => hoisted.state.tasks.slice(0, n),
            }),
          }),
        }),
      }),
    }),
  };
});

function resetState(): void {
  hoisted.state.tasks.length = 0;
}

describe("brain-task-slot — repo/baseBranch/tags (S9 top task-context bar)", () => {
  beforeEach(() => {
    resetState();
  });

  it("returns nulls when no task is found for the thread", async () => {
    const result = await brainTaskSlot.run({ threadId: "thread-none" });
    expect(result).toEqual({
      status: null,
      runId: null,
      updatedAt: null,
      repo: null,
      baseBranch: null,
      tags: null,
    });
  });

  it("passes through repo/baseBranch and strips the internal brainThreadId beacon from tags", async () => {
    hoisted.state.tasks.push({
      status: "running",
      runId: "run_1",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      repo: "payhub",
      baseBranch: "sprint-3",
      tags: {
        item_id: "PAY-201",
        sprint_id: "sprint-3",
        brainThreadId: "thread-1",
      },
    });

    const result = await brainTaskSlot.run({ threadId: "thread-1" });
    expect(result.repo).toBe("payhub");
    expect(result.baseBranch).toBe("sprint-3");
    expect(result.tags).toEqual({ item_id: "PAY-201", sprint_id: "sprint-3" });
    expect(result.tags).not.toHaveProperty("brainThreadId");
  });

  it("tags is null when the task carries no tags", async () => {
    hoisted.state.tasks.push({
      status: "done",
      runId: null,
      updatedAt: new Date(),
      repo: null,
      baseBranch: null,
      tags: null,
    });

    const result = await brainTaskSlot.run({ threadId: "thread-1" });
    expect(result.tags).toBeNull();
  });
});
