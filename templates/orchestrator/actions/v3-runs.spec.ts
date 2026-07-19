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

/**
 * Reconstruct the SQL text of a drizzle `sql` tagged-template object.
 *
 * The object handed to db.execute exposes its static SQL fragments in
 * `queryChunks[].value` (arrays of strings); parameter values appear as bare
 * string/number chunks. String(q) is just "[object Object]", so we walk the
 * chunks and concatenate the literal SQL. Param values are irrelevant to the
 * column-shape assertions and are intentionally skipped.
 */
function extractSqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return String(q);
  let out = "";
  for (const chunk of chunks) {
    const value = (chunk as { value?: unknown })?.value;
    if (Array.isArray(value)) {
      out += value.map((v) => String(v)).join("");
    }
  }
  return out;
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

  it("regression: spawn-cleanup SQL scopes by node_id via a v3_nodes subquery, NOT a bare run_id column on v3_spawns", async () => {
    // v3_spawns has NO run_id column (only node_id — see
    // server/db/v3-schema.ts). The old query filtered v3_spawns directly by
    // `WHERE run_id = ...`, which fails in production with
    // 'column "run_id" does not exist', attaches a spurious `warning` to every
    // successful cancel, and leaves running spawns un-cancelled. Capture the
    // actual SQL text handed to db.execute and lock in the correct shape.
    let captured: unknown;
    hoisted.state.executeImpl = async (q: unknown) => {
      captured = q;
      return { rows: [] };
    };

    const result = await runCancel.run({ runId: "run-1" });

    // The spawn-cleanup query ran and did not produce a warning.
    expect(hoisted.state.executeCalls).toBe(1);
    expect((result as any).warning).toBeUndefined();
    expect(captured).toBeDefined();

    // The drizzle `sql` tagged template yields an object whose static SQL text
    // lives in queryChunks[].value (param values are bare string chunks).
    // String(q) is just "[object Object]", so reconstruct the text here.
    const sqlText = extractSqlText(captured);

    // Positive: spawns are scoped to this run via node_id IN (v3_nodes subquery
    // keyed by run_id) — the exact pattern used in actions/v3-archive.ts.
    expect(sqlText).toContain("v3_nodes");
    expect(sqlText).toMatch(
      /node_id\s+IN\s*\(\s*SELECT id FROM v3_nodes WHERE run_id\s*=/,
    );

    // Negative: the v3_spawns UPDATE's OWN WHERE clause (everything before the
    // node_id subquery) must not reference run_id as a column of v3_spawns. In
    // the buggy version there was no `node_id IN`, so this slice is the whole
    // statement and DOES contain `run_id` — failing the assertion.
    const updateWhere = sqlText.split("node_id IN")[0];
    expect(updateWhere).toMatch(/UPDATE v3_spawns/);
    expect(updateWhere).not.toMatch(/\brun_id\b/);
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
