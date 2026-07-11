// runCancel — F10 R9 defensive success reporting (docs/sdlc-impl-f5-f10.md
// §6A row 4, T-F10-07; docs/sdlc-product-design/02-workflows.md §4 R9,
// SDLC-050: "runCancel 幂等且成功必须返回成功").
//
// R3 correction (already reflected in this worktree's baseline): the old
// `sql.raw` bug that made runCancel report "Failed query" even when the
// cancel had already committed is ALREADY fixed here (the spawn-cleanup query
// uses the `sql` tagged template, not `sql.raw`). This test file only proves
// the remaining, still-needed defensive shape: if the run-cancel UPDATE
// succeeds but the FOLLOW-UP spawn-cleanup query throws for any reason
// (transient DB error, etc.), the action must still report
// `{ cancelled: true, warning }` — never throw and never claim the
// already-successful cancel failed.
//
// Uses the same minimal hand-rolled server/db/index.js mock as
// actions/v3-run-detail.spec.ts (see that file's header for the rationale).

import { describe, it, expect, beforeEach, vi } from "vitest";

import { runCancel } from "./v3-runs.js";

const hoisted = vi.hoisted(() => {
  const state = {
    runs: [] as Array<Record<string, any>>,
    executeImpl: null as null | ((q: unknown) => Promise<unknown>),
    executeCalls: 0,
  };

  function isRunsTable(table: unknown): boolean {
    return (
      table !== null &&
      typeof table === "object" &&
      "dagVersion" in (table as object)
    );
  }

  function makeDb() {
    return {
      select: (_cols?: unknown) => ({
        from: (table: unknown) => ({
          where: (_filter: unknown) => ({
            limit: (n: number) =>
              isRunsTable(table) ? state.runs.slice(0, n) : [],
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (data: Record<string, unknown>) => ({
          where: async (_filter: unknown) => {
            if (isRunsTable(table)) {
              for (const row of state.runs) Object.assign(row, data);
            }
          },
        }),
      }),
      execute: async (q: unknown) => {
        state.executeCalls++;
        if (state.executeImpl) return state.executeImpl(q);
        return { rows: [] };
      },
    };
  }

  return { state, makeDb };
});

vi.mock("../server/db/index.js", async () => {
  const v3Schema = await vi.importActual<
    typeof import("../server/db/v3-schema.js")
  >("../server/db/v3-schema.js");
  return {
    v3Schema,
    schema: {},
    getV3Db: () => hoisted.makeDb(),
    getDbExec: () => hoisted.makeDb(),
    resolveOwnerEmail: () => "local@localhost",
  };
});

function resetState(): void {
  hoisted.state.runs.length = 0;
  hoisted.state.executeImpl = null;
  hoisted.state.executeCalls = 0;
  hoisted.state.runs.push({
    id: "run-1",
    status: "running",
    ownerEmail: "local@localhost",
  });
}

describe("runCancel — F10 R9 defensive success reporting (T-F10-07)", () => {
  beforeEach(() => {
    resetState();
  });

  it("baseline: cancels a running run with no warning when spawn cleanup succeeds", async () => {
    const result = await runCancel.run({ runId: "run-1" });

    expect(result).toEqual({
      runId: "run-1",
      previousStatus: "running",
      status: "cancelled",
    });
    expect((result as any).warning).toBeUndefined();
    expect(hoisted.state.runs[0]?.status).toBe("cancelled");
  });

  it("T-F10-07: cancel takes effect + returns warning (not an exception) when the follow-up spawn query throws", async () => {
    hoisted.state.executeImpl = async () => {
      throw new Error("connection reset by peer");
    };

    // Must NOT throw — the run cancellation already committed.
    const result = await runCancel.run({ runId: "run-1" });

    expect(result.runId).toBe("run-1");
    expect(result.status).toBe("cancelled");
    expect((result as any).warning).toBeDefined();
    expect((result as any).warning).toContain("connection reset by peer");

    // The cancellation write itself DID take effect.
    expect(hoisted.state.runs[0]?.status).toBe("cancelled");
  });

  it("rejects cancelling an already-cancelled run (unchanged behavior)", async () => {
    hoisted.state.runs[0].status = "cancelled";

    await expect(runCancel.run({ runId: "run-1" })).rejects.toThrow(
      /already cancelled/i,
    );
  });

  it("rejects cancelling a 'done' run (unchanged behavior)", async () => {
    hoisted.state.runs[0].status = "done";

    await expect(runCancel.run({ runId: "run-1" })).rejects.toThrow(
      /already done/i,
    );
  });
});
