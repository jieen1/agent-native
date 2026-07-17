// runState — s7-run-detail parity: surfaces `inputs` (repo/baseBranch/
// targetBranch/brief/tags-style JSONB set when the run was started) so the
// "输入与产物" inspector tab has real data instead of nothing. Additive-only:
// the run row already carried `inputs`, this just adds it to the response.
//
// Mock follows the same hand-rolled table-duck-typing technique as
// actions/v3-run-detail.spec.ts / v3-runs.spec.ts, extended with a `groupBy`
// terminal (runState's node-count query groups by status, unlike the other
// specs' single-row selects).

import { describe, it, expect, beforeEach, vi } from "vitest";

import { runState } from "./v3-runs.js";

const hoisted = vi.hoisted(() => {
  const state = {
    runs: [] as Array<Record<string, any>>,
    nodes: [] as Array<Record<string, any>>,
  };

  function isRunsTable(table: unknown): boolean {
    return (
      table !== null &&
      typeof table === "object" &&
      "dagVersion" in (table as object)
    );
  }
  function isNodesTable(table: unknown): boolean {
    return (
      table !== null &&
      typeof table === "object" &&
      "nodeIdInDag" in (table as object)
    );
  }

  function makeDb() {
    return {
      select: (_cols?: unknown) => ({
        from: (table: unknown) => ({
          where: (_filter: unknown) => ({
            limit: (n: number) =>
              isRunsTable(table) ? state.runs.slice(0, n) : [],
            groupBy: (_col: unknown) => {
              if (!isNodesTable(table)) return [];
              const counts = new Map<string, number>();
              for (const n of state.nodes) {
                counts.set(n.status, (counts.get(n.status) ?? 0) + 1);
              }
              return [...counts.entries()].map(([status, count]) => ({
                status,
                count,
              }));
            },
          }),
        }),
      }),
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
  hoisted.state.nodes.length = 0;
}

describe("runState — surfaces run.inputs (s7-run-detail 输入与产物 tab)", () => {
  beforeEach(() => {
    resetState();
  });

  it("returns the run's inputs JSONB alongside the existing fields", async () => {
    const inputs = {
      repo: "payhub",
      baseBranch: "main",
      targetBranch: "sprint-3",
      brief: "brief:PAY-201",
    };
    hoisted.state.runs.push({
      id: "run-1",
      templateId: "sdlc-issue-pipeline",
      templateVersion: 4,
      status: "running",
      priority: 0,
      tags: { item_id: "PAY-201" },
      inputs,
      dagVersion: 1,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: null,
      ownerEmail: "local@localhost",
    });
    hoisted.state.nodes.push(
      { runId: "run-1", status: "done" },
      { runId: "run-1", status: "running" },
    );

    const result = await runState.run({ runId: "run-1" });

    expect(result.inputs).toEqual(inputs);
    expect(result.totalNodes).toBe(2);
    expect(result.nodeCounts).toEqual({ done: 1, running: 1 });
  });

  it("throws when the run is not found", async () => {
    await expect(runState.run({ runId: "missing" })).rejects.toThrow(
      /not found/i,
    );
  });
});
