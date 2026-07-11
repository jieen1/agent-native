// nodeRetry — F10 R9 admission widening (docs/sdlc-impl-f5-f10.md §6A row 3,
// T-F10-06; docs/sdlc-product-design/02-workflows.md §4 R9, SDLC-050).
//
// Current admission (pre-F10, unchanged): node.status ∈ {failed, cancelled}.
// F10 adds exactly ONE more admission branch: node NOT already terminal
// (e.g. still 'running') AND its bound currentSpawnId points at a v3_spawns
// row that has ALREADY reached a terminal status (done/failed/cancelled) —
// the B2 hung-node shape (SDLC-050) that server/engine/v3-reconciler.ts's
// tick() conduction rule should normally already have migrated, with
// nodeRetry staying a defensive manual escape hatch for the window before
// that happens. A genuinely healthy running node (no spawn bound yet, or a
// spawn that is itself still running/pending) must still be rejected.
//
// Uses a minimal hand-rolled mock of server/db/index.js — there is no
// existing actions/*.spec.ts precedent in this template to follow, so this
// mirrors the same table-duck-typing technique as
// server/engine/v3-reconciler.spec.ts, scoped to the much smaller query
// surface nodeRetry actually issues (single-row select/update, no raw SQL).

import { describe, it, expect, beforeEach, vi } from "vitest";

import { nodeRetry } from "./v3-run-detail.js";

const hoisted = vi.hoisted(() => {
  const state = {
    nodes: [] as Array<Record<string, any>>,
    runs: [] as Array<Record<string, any>>,
    spawns: [] as Array<Record<string, any>>,
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
  function isSpawnsTable(table: unknown): boolean {
    return (
      table !== null &&
      typeof table === "object" &&
      "renderedPrompt" in (table as object)
    );
  }

  function rowsFor(table: unknown): Array<Record<string, any>> {
    if (isRunsTable(table)) return state.runs;
    if (isNodesTable(table)) return state.nodes;
    if (isSpawnsTable(table)) return state.spawns;
    return [];
  }

  // Deliberately filter-blind (like the reconciler spec's mock): every test
  // below keeps exactly one relevant row per table, so "ignore the WHERE,
  // return everything (sliced to `limit`)" always resolves the row the
  // production code actually meant to select.
  function makeDb() {
    return {
      select: (_cols?: unknown) => ({
        from: (table: unknown) => ({
          where: (_filter: unknown) => ({
            limit: (n: number) => rowsFor(table).slice(0, n),
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (data: Record<string, unknown>) => ({
          where: async (_filter: unknown) => {
            for (const row of rowsFor(table)) Object.assign(row, data);
          },
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
  hoisted.state.nodes.length = 0;
  hoisted.state.runs.length = 0;
  hoisted.state.spawns.length = 0;
  hoisted.state.runs.push({ id: "run-1", ownerEmail: "local@localhost" });
}

describe("nodeRetry — F10 R9 admission widening (T-F10-06)", () => {
  beforeEach(() => {
    resetState();
  });

  it("baseline unchanged: still accepts a 'failed' node", async () => {
    hoisted.state.nodes.push({
      id: "node-1",
      runId: "run-1",
      status: "failed",
      currentSpawnId: null,
    });

    const result = await nodeRetry.run({ runId: "run-1", nodeId: "node-1" });

    expect(result).toEqual({
      nodeId: "node-1",
      previousStatus: "failed",
      status: "ready",
    });
    expect(hoisted.state.nodes[0]?.status).toBe("ready");
  });

  it("T-F10-06: accepts a non-terminal (running) node whose current spawn already terminal (failed)", async () => {
    hoisted.state.nodes.push({
      id: "node-1",
      runId: "run-1",
      status: "running",
      currentSpawnId: "spawn-1",
    });
    hoisted.state.spawns.push({ id: "spawn-1", status: "failed" });

    const result = await nodeRetry.run({ runId: "run-1", nodeId: "node-1" });

    expect(result).toEqual({
      nodeId: "node-1",
      previousStatus: "running",
      status: "ready",
    });
    expect(hoisted.state.nodes[0]?.status).toBe("ready");
    expect(hoisted.state.nodes[0]?.currentSpawnId).toBeNull();
  });

  it("T-F10-06: accepts a non-terminal node whose current spawn is 'cancelled' (also terminal)", async () => {
    hoisted.state.nodes.push({
      id: "node-1",
      runId: "run-1",
      status: "running",
      currentSpawnId: "spawn-1",
    });
    hoisted.state.spawns.push({ id: "spawn-1", status: "cancelled" });

    const result = await nodeRetry.run({ runId: "run-1", nodeId: "node-1" });

    expect(result.status).toBe("ready");
  });

  it("T-F10-06: rejects a healthy running node whose current spawn is still running", async () => {
    hoisted.state.nodes.push({
      id: "node-1",
      runId: "run-1",
      status: "running",
      currentSpawnId: "spawn-1",
    });
    hoisted.state.spawns.push({ id: "spawn-1", status: "running" });

    await expect(
      nodeRetry.run({ runId: "run-1", nodeId: "node-1" }),
    ).rejects.toThrow(/running/i);

    // Untouched — no admission means no write.
    expect(hoisted.state.nodes[0]?.status).toBe("running");
  });

  it("T-F10-06: rejects a running node with no spawn bound yet (never dispatched)", async () => {
    hoisted.state.nodes.push({
      id: "node-1",
      runId: "run-1",
      status: "running",
      currentSpawnId: null,
    });

    await expect(
      nodeRetry.run({ runId: "run-1", nodeId: "node-1" }),
    ).rejects.toThrow(/running/i);
  });

  it("rejects an already-terminal 'done' node (never admitted)", async () => {
    hoisted.state.nodes.push({
      id: "node-1",
      runId: "run-1",
      status: "done",
      currentSpawnId: "spawn-1",
    });
    hoisted.state.spawns.push({ id: "spawn-1", status: "done" });

    await expect(
      nodeRetry.run({ runId: "run-1", nodeId: "node-1" }),
    ).rejects.toThrow(/done/i);
  });
});
